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
  'The combined browser application includes Chessground and chessops under GPL-3.0-or-later. Original application code remains available under MIT; see LICENSE.txt. Corresponding source: https://github.com/Kamkmgamer/kamkmchess. Distributors must provide the exact corresponding source for their deployed version.',
  'The Wikimedia standard chess pieces by Cburnett and Rfc1394 are distributed under CC BY-SA 3.0, extracted into individual SVG files from the cm-chessboard standard sprite. Source and license notices are embedded in each image.',
];
const inventory = [];

for (const metadata of packages.values()) {
  const directory = metadata.path;
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (manifest.version !== metadata.version) {
    throw new Error(`Installed version differs from lockfile: ${metadata.name}`);
  }

  const files = await readdir(directory);
  const licenseFile = files.find((file) => /^licen[sc]e(?:\.(?:txt|md))?$/i.test(file));
  // This exact release distributes its complete BSD terms in README.md.
  const readmeLicense = manifest.name === 'glob-to-regexp' && manifest.version === '0.4.1'
    ? (await readFile(join(directory, 'README.md'), 'utf8')).match(/^## License\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.trim()
    : undefined;
  const licenseText = licenseFile ? await readFile(join(directory, licenseFile), 'utf8') : readmeLicense;
  if (!licenseText) {
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
    licenseText,
  );
}

sections.push(
  'T3 Code theme palette data',
  'Palette values extracted from packages/shared/src/themePalettes.ts at commit 9503155da67add4fbd7fbc51c99ec19a0c8c4a2c (SHA-256 82385050b8b691ff280efc0e93ea9dd8a4bbfd64a4c50cf8536b5c15d1e74479).',
  await readFile(new URL('docs/licenses/T3-Code-MIT.txt', root), 'utf8'),
  'Wikimedia standard chess pieces',
  'Artists: Cburnett and Rfc1394. Source: https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces/Standard. Extracted into individual SVG files from cm-chessboard@8.15.3/assets/pieces/standard.svg under Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0): https://creativecommons.org/licenses/by-sa/3.0/. Each image contains attribution, source and modification notices.',
);

await copyFile(new URL('LICENSE', root), new URL('dist/LICENSE.txt', root));
await writeFile(new URL('dist/THIRD_PARTY_NOTICES.txt', root), `${sections.join('\n\n')}\n`);
await writeFile(
  new URL('dist/DEPENDENCY_INVENTORY.json', root),
  `${JSON.stringify({ lockfileVersion, packages: inventory }, null, 2)}\n`,
);
console.log(`Wrote distribution notices to ${fileURLToPath(new URL('dist/', root))}`);
