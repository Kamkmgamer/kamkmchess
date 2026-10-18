import { execSync } from 'node:child_process';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const lock = await readFile(new URL('pnpm-lock.yaml', root), 'utf8');
const lockfileVersion = lock.match(/^lockfileVersion:\s*['"]?([^'"\s]+)/m)?.[1];
if (!lockfileVersion) throw new Error('pnpm-lock.yaml has no lockfileVersion.');

const dependencyTree = JSON.parse(
  execSync('corepack pnpm list --prod --depth Infinity --json', {
    cwd: rootPath,
    encoding: 'utf8',
  }),
);
const packages = new Map();

/**
 * @typedef {{ path: string, version: string, dependencies?: Record<string, Dependency>, optionalDependencies?: Record<string, Dependency> }} Dependency
 * @param {Record<string, Dependency> | undefined} dependencies
 */
function collect(dependencies, optional = false) {
  for (const [name, dependency] of Object.entries(dependencies ?? {})) {
    if (!dependency.path || !dependency.version) {
      throw new Error(`pnpm did not resolve the production dependency ${name}`);
    }
    const previous = packages.get(dependency.path);
    packages.set(dependency.path, {
      name,
      version: dependency.version,
      path: dependency.path,
      optional: optional || previous?.optional === true,
    });
    collect(dependency.dependencies, optional);
    collect(dependency.optionalDependencies, true);
  }
}

for (const project of dependencyTree) collect(project.dependencies);
const sections = [
  'Third-party code notices',
  'Generated from pnpm-lock.yaml and the installed production packages.',
  'Original application code is MIT licensed. See LICENSE.txt.',
  'The hero uses the original knight-versus-models image generated for kamkm chess. Its animated gradient overlay uses DitherGradient by ripgrim from Boring-Software-Inc/dither-kit, revision 1e7faee9aa252e499651e6736ed65f7a07d9a6bd, declared MIT in the upstream package manifests. Source: https://github.com/Boring-Software-Inc/dither-kit. Chess and interface icons are Font Awesome Free SVGs (CC BY 4.0); its JavaScript code is MIT licensed. AI brand names and marks depicted in the artwork remain trademarks of their owners.',
  'Quartz design system source, copyright (c) 2026 Arlan Marat, is included under the MIT license below.',
  'The earlier image-dithering core remains vendored from github.com/jvgomg/ditherkit by James Greenaway under the MIT license below; the hero no longer imports it.',
  (await readFile(new URL('src/components/dither-kit/LICENSE', root), 'utf8')),
  await readFile(new URL('docs/design/QUARTZ-LICENSE.txt', root), 'utf8'),
];
const inventory = [];

for (const metadata of packages.values()) {
  const directory = metadata.path;
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.version !== metadata.version) {
    throw new Error(`Installed version differs from lockfile: ${metadata.name}`);
  }

  const files = await readdir(directory);
  const licenseFile = files.find((file) => /^license(?:\.(?:txt|md))?$/i.test(file));
  if (!licenseFile) {
    throw new Error(`Review the missing license text for ${manifest.name}`);
  }

  inventory.push({
    path: metadata.name,
    version: metadata.version,
    license: manifest.license,
    scope: 'runtime',
    optional: metadata.optional === true,
  });
  sections.push(
    `${manifest.name}@${manifest.version} (${manifest.license ?? 'license not declared'})`,
    `Source: ${manifest.homepage ?? manifest.repository?.url ?? `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`}`,
    await readFile(join(directory, licenseFile), 'utf8'),
  );
}

await copyFile(new URL('LICENSE', root), new URL('dist/LICENSE.txt', root));
await writeFile(new URL('dist/THIRD_PARTY_NOTICES.txt', root), `${sections.join('\n\n')}\n`);
await writeFile(
  new URL('dist/DEPENDENCY_INVENTORY.json', root),
  `${JSON.stringify({ lockfileVersion, packages: inventory }, null, 2)}\n`,
);
console.log(`Wrote distribution notices to ${fileURLToPath(new URL('dist/', root))}`);
