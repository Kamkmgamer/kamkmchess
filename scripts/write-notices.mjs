import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
const sections = [
  'Third-party code notices',
  'Generated from package-lock.json and the installed production packages.',
  'Original application code is MIT licensed. See LICENSE.txt.',
  'No third-party artwork is distributed in this foundation build.',
];
const inventory = [];

for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path) continue;

  inventory.push({
    path,
    version: metadata.version,
    license: metadata.license,
    scope: metadata.dev ? 'tooling' : 'runtime',
    optional: metadata.optional === true,
  });
  if (metadata.dev) continue;

  const directory = new URL(`${path}/`, root);
  const manifest = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
  if (manifest.version !== metadata.version) {
    throw new Error(`Installed version differs from lockfile: ${path}`);
  }

  const files = await readdir(directory);
  const licenseFile = files.find((file) => /^license(?:\.(?:txt|md))?$/i.test(file));
  if (!licenseFile) {
    throw new Error(`Review the missing license text for ${manifest.name}`);
  }

  sections.push(
    `${manifest.name}@${manifest.version} (${manifest.license})`,
    `Source: ${manifest.homepage ?? manifest.repository?.url ?? metadata.resolved}`,
    await readFile(new URL(licenseFile, directory), 'utf8'),
  );
}

await copyFile(new URL('LICENSE', root), new URL('dist/LICENSE.txt', root));
await writeFile(new URL('dist/THIRD_PARTY_NOTICES.txt', root), `${sections.join('\n\n')}\n`);
await writeFile(
  new URL('dist/DEPENDENCY_INVENTORY.json', root),
  `${JSON.stringify({ lockfileVersion: lock.lockfileVersion, packages: inventory }, null, 2)}\n`,
);
console.log(`Wrote distribution notices to ${fileURLToPath(new URL('dist/', root))}`);
