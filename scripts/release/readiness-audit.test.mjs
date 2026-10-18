// Offline tests for the release readiness audit.
//
// Each test builds a throwaway repository tree, runs the same exported audit
// entry point the CLI uses, and asserts the finding. Nothing here touches the
// network, a real bundle or a credential.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { auditRepository, scanServerOnlyNames, scanText, selfCheckCanary } from './readiness-audit.mjs';

/**
 * @typedef {import('./readiness-audit.mjs').Finding} Finding
 * @typedef {import('./readiness-audit.mjs').AuditReport} AuditReport
 */

/** @type {string[]} */
const trees = [];

after(async () => {
  await Promise.all(trees.map((directory) => rm(directory, { recursive: true, force: true })));
});

/**
 * @param {Record<string, string>} files
 * @returns {Promise<string>}
 */
async function makeTree(files) {
  const root = await mkdtemp(join(tmpdir(), 'kha-readiness-'));
  trees.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
}

/** @param {Finding[]} findings @returns {string[]} */
function codes(findings) {
  return findings.map((finding) => finding.code);
}

/**
 * @param {Finding[]} findings
 * @param {string} code
 * @returns {Finding|undefined}
 */
function findingFor(findings, code) {
  return findings.find((finding) => finding.code === code);
}

/** @satisfies {Record<string, string>} */
const minimalTree = {
  'vercel.json': JSON.stringify({
    framework: 'vite',
    rewrites: [{ source: '/v1/:path*', destination: '/api/index?path=:path*' }],
    headers: [{
      source: '/(.*)',
      headers: [{
        key: 'Content-Security-Policy',
        value: "default-src 'none'; script-src 'self'; connect-src 'self' https:; worker-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
      }],
    }],
  }),
  'backend/httpapi/api.go': [
    'package httpapi',
    'func New(store Store) http.Handler {',
    '\tmux.HandleFunc("GET /v1/games", api.list)',
    '\tmux.HandleFunc("POST /v1/games", api.create)',
    '}',
    'func (a *API) list(w http.ResponseWriter, r *http.Request) { if _, ok := auth.Owner(r.Context()); !ok { return } }',
    'func (a *API) create(w http.ResponseWriter, r *http.Request) { if _, ok := auth.Owner(r.Context()); !ok { return } }',
  ].join('\n'),
  'backend/backup/backup.go': 'package backup\n',
  'backend/backup/cmd/khabackup/main.go': 'package main\n',
  'docs/implementation/MVP-operations.md': '# operations\n',
  '.env.example': 'CLOUD_STORAGE_ENABLED=false\n',
  '.gitignore': '.env\n',
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'go.sum': '',
  '.node-version': '24.22.0\n',
  'package.json': JSON.stringify({ engines: { node: '>=24.22.0 <25' } }),
  'api/index.go': 'func Handler(w http.ResponseWriter, r *http.Request) {\n\tif os.Getenv("CLOUD_STORAGE_ENABLED") != "true" {\n\t\tw.WriteHeader(http.StatusServiceUnavailable)\n\t}\n}',
};

test('the scanner matches a planted canary and ignores ordinary text', () => {
  const detected = selfCheckCanary('sk-TESTCANARY0123456789abcdef');
  assert.equal(detected.detected, true);
  assert.deepEqual(detected.matchedRules, ['openai-style-key']);
  assert.deepEqual(scanText('const pieces = document.querySelectorAll(".square");'), []);
  assert.deepEqual(scanText('const x = "-----BEGIN RSA PRIVATE KEY-----";'), ['private-key']);
  assert.deepEqual(scanText('const url = "postgres://user:hunter2@db.example.internal/app";'), ['connection-string']);
  assert.deepEqual(scanText('const h = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.abcdefghijklmnop";'), ['jwt']);
});

test('server-only configuration names are recognised', () => {
  assert.deepEqual(scanServerOnlyNames('process.env.DATABASE_URL'), ['DATABASE_URL']);
  assert.deepEqual(scanServerOnlyNames('const endpoint = "/v1/games";'), []);
});

test('a complete tree reports no blocker', async () => {
  const report = await auditRepository(await makeTree(minimalTree));
  assert.equal(report.counts.blocker, 0, JSON.stringify(report.findings, null, 1));
  assert.equal(report.status, 'review');
  assert.ok(report.disclaimer.includes('no network request'));
});

test('a bundle carrying a credential shape is a blocker', async () => {
  const root = await makeTree({
    ...minimalTree,
    'dist/index.html': '<!doctype html><title>app</title>',
    'dist/assets/app.js': 'const config = { apiKey: "sk-LIVE0123456789abcdefghij" };',
    'dist/LICENSE.txt': 'MIT License',
    'dist/THIRD_PARTY_NOTICES.txt': 'MIT ... CC BY-SA ... Cburnett ...',
    'dist/DEPENDENCY_INVENTORY.json': JSON.stringify({ lockfileVersion: '9.0', packages: [{ path: 'chess.js', license: 'BSD-2-Clause' }] }),
  });
  const report = await auditRepository(root);
  const blocker = findingFor(report.findings, 'bundle-secret-pattern');
  assert.ok(blocker, JSON.stringify(codes(report.findings)));
  assert.equal(blocker.severity, 'blocker');
  assert.equal(report.status, 'blocked');
});

test('server-only configuration in the bundle is a blocker', async () => {
  const root = await makeTree({
    ...minimalTree,
    'dist/assets/app.js': 'const url = process.env.DATABASE_URL; const on = process.env.CLOUD_STORAGE_ENABLED;',
  });
  const report = await auditRepository(root);
  const blocker = findingFor(report.findings, 'bundle-server-config');
  assert.ok(blocker);
  assert.match(blocker.message, /DATABASE_URL/);
  assert.match(blocker.message, /CLOUD_STORAGE_ENABLED/);
});

test('missing distribution notices block a release', async () => {
  const root = await makeTree({ ...minimalTree, 'dist/index.html': '<!doctype html>' });
  const report = await auditRepository(root);
  const missing = report.findings.filter((finding) => finding.code === 'dist-notice-missing');
  assert.equal(missing.length, 3, JSON.stringify(codes(report.findings)));
  assert.ok(findingFor(report.findings, 'dist-missing') === undefined);
  assert.deepEqual(
    missing.map((finding) => finding.file),
    ['dist/DEPENDENCY_INVENTORY.json', 'dist/LICENSE.txt', 'dist/THIRD_PARTY_NOTICES.txt'],
  );
});

test('reviewed pinned GPL chess dependencies are allowed in the GPL project', async () => {
  const root = await makeTree({
    ...minimalTree,
    'dist/DEPENDENCY_INVENTORY.json': JSON.stringify({
      lockfileVersion: '9.0',
      packages: [
        { path: 'chessops', version: '0.15.1', license: 'GPL-3.0-or-later' },
        { path: '@lichess-org/chessground', version: '10.4.2', license: 'GPL-3.0-or-later' },
        { path: 'stockfish', version: '19.0.1', license: 'GPL-3.0' },
      ],
    }),
  });
  const report = await auditRepository(root);
  assert.equal(findingFor(report.findings, 'license-excluded'), undefined);
});

test('a changed version or license of a reviewed GPL dependency still requires review', async () => {
  const root = await makeTree({
    ...minimalTree,
    'dist/DEPENDENCY_INVENTORY.json': JSON.stringify({
      lockfileVersion: '9.0',
      packages: [
        { path: 'stockfish', version: '20.0.0', license: 'GPL-3.0' },
        { path: 'chessops', version: '0.15.1', license: 'AGPL-3.0-or-later' },
      ],
    }),
  });
  const report = await auditRepository(root);
  assert.equal(report.findings.filter((finding) => finding.code === 'license-excluded').length, 2);
});

test('an unreviewed copyleft or noncommercial dependency blocks a release', async () => {
  const root = await makeTree({
    ...minimalTree,
    'dist/DEPENDENCY_INVENTORY.json': JSON.stringify({
      lockfileVersion: '9.0',
      packages: [
        { path: 'chess.js', license: 'BSD-2-Clause' },
        { path: 'stock-solver', license: 'GPL-3.0' },
        { path: 'theme-pack', license: 'CC BY-NC 4.0 NonCommercial' },
      ],
    }),
    'dist/THIRD_PARTY_NOTICES.txt': 'MIT ... CC BY-SA ... Cburnett ...',
  });
  const report = await auditRepository(root);
  const excluded = report.findings.filter((finding) => finding.code === 'license-excluded');
  assert.equal(excluded.length, 2);
  assert.ok(excluded.every((finding) => finding.severity === 'blocker'));
});

test('a CSP without public HTTPS blocks direct browser generation', async () => {
  const root = await makeTree({
    ...minimalTree,
    'vercel.json': JSON.stringify({
      ...JSON.parse(minimalTree['vercel.json']),
      headers: [{
        source: '/(.*)',
        headers: [{
          key: 'Content-Security-Policy',
          value: "default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; object-src 'none'",
        }],
      }],
    }),
  });
  const report = await auditRepository(root);
  assert.ok(findingFor(report.findings, 'csp-connect-blocks-provider'));
  assert.ok(findingFor(report.findings, 'csp-frame-ancestors'));
});

test('cleartext HTTP to a remote host is a blocker', async () => {
  const root = await makeTree({
    ...minimalTree,
    'vercel.json': JSON.stringify({
      ...JSON.parse(minimalTree['vercel.json']),
      headers: [{
        source: '/(.*)',
        headers: [{
          key: 'Content-Security-Policy',
          value: "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self' https: http://proxy.example.com:8080; worker-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
        }],
      }],
    }),
  });
  const report = await auditRepository(root);
  assert.ok(findingFor(report.findings, 'csp-connect-allows-plain-http'));
  assert.ok(findingFor(report.findings, 'csp-script-unsafe'));
});

test('an unrouted API prefix blocks a release', async () => {
  const root = await makeTree({
    ...minimalTree,
    'vercel.json': JSON.stringify({ ...JSON.parse(minimalTree['vercel.json']), rewrites: [{ source: '/(.*)', destination: '/index.html' }] }),
  });
  const report = await auditRepository(root);
  assert.ok(findingFor(report.findings, 'api-route-unrouted'));
});

test('a Go server that touches a provider key or host blocks a release', async () => {
  const root = await makeTree({
    ...minimalTree,
    'backend/serverapp/server.go': 'package serverapp\n\nconst key = os.Getenv("OPENAI_API_KEY")\nconst relay = "https://api.openai.com/v1/responses"\n',
  });
  const report = await auditRepository(root);
  assert.ok(findingFor(report.findings, 'server-provider-key'));
  assert.ok(findingFor(report.findings, 'server-provider-relay'));
});

test('an API handler without an owner guard blocks a release', async () => {
  const root = await makeTree({
    ...minimalTree,
    'backend/httpapi/api.go': [
      'func New(store Store) http.Handler {',
      '\tmux.HandleFunc("GET /v1/games", api.list)',
      '\tmux.HandleFunc("DELETE /v1/games/{gameID}", api.remove)',
      '}',
      'func (a *API) list(w http.ResponseWriter, r *http.Request) { if _, ok := auth.Owner(r.Context()); !ok { return } }',
      'func (a *API) remove(w http.ResponseWriter, r *http.Request) { a.store.Delete(r.Context(), "anyone", in) }',
    ].join('\n'),
  });
  const report = await auditRepository(root);
  assert.ok(findingFor(report.findings, 'api-owner-guard'));
});

test('an enabled or unenforced account storage gate blocks a release', async () => {
  const enabled = await auditRepository(await makeTree({ ...minimalTree, '.env.example': 'CLOUD_STORAGE_ENABLED=true\n' }));
  assert.ok(findingFor(enabled.findings, 'storage-gate-enabled'));

  const unenforced = await auditRepository(await makeTree({ ...minimalTree, 'api/index.go': 'func Handler(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }\n' }));
  assert.ok(findingFor(unenforced.findings, 'storage-gate-unenforced'));
});

test('the audit always reports the hosted backup rehearsal gap', async () => {
  const report = await auditRepository(await makeTree(minimalTree));
  const gap = findingFor(report.findings, 'backup-rehearsal-hosted');
  assert.ok(gap);
  assert.equal(gap.severity, 'external');
  assert.equal(report.counts.external, 2, JSON.stringify(codes(report.findings)));

  /** @type {Record<string, string>} */
  const noRunbook = { ...minimalTree };
  delete noRunbook['docs/implementation/MVP-operations.md'];
  const undocumented = await auditRepository(await makeTree(noRunbook));
  assert.ok(findingFor(undocumented.findings, 'operations-doc-missing'));
});

test('a missing Clerk browser SDK is an external gap, not a false pass', async () => {
  const report = await auditRepository(await makeTree(minimalTree));
  assert.ok(findingFor(report.findings, 'clerk-browser-sdk-absent'));
  assert.ok(!findingFor(report.findings, 'clerk-csp-allowed'));
});

test('a committed Clerk SDK without a CSP allowance is reported against the storage gate', async () => {
  const withClerk = {
    ...minimalTree,
    'package.json': JSON.stringify({ engines: { node: '>=24.22.0 <25' }, dependencies: { '@clerk/clerk-js': '6.39.1' } }),
  };
  const gated = await auditRepository(await makeTree(withClerk));
  const warning = findingFor(gated.findings, 'clerk-csp-missing');
  assert.ok(warning);
  assert.equal(warning.severity, 'warning');
  assert.match(warning.message, /gated off/);

  const enabled = await auditRepository(await makeTree({ ...withClerk, '.env.example': 'CLOUD_STORAGE_ENABLED=true\n' }));
  const blocker = findingFor(enabled.findings, 'clerk-csp-missing');
  assert.ok(blocker);
  assert.equal(blocker.severity, 'blocker');
  assert.match(blocker.message, /account storage is enabled/);
});

test('an unignored .env file blocks a release', async () => {
  const report = await auditRepository(await makeTree({ ...minimalTree, '.gitignore': 'node_modules/\n' }));
  assert.ok(findingFor(report.findings, 'env-not-ignored'));
});

test('a competing static-host policy is reported without being edited', async () => {
  const report = await auditRepository(await makeTree({
    ...minimalTree,
    'public/_headers': '/*\n  Content-Security-Policy: default-src \'none\'\n',
    'public/_redirects': '/* /index.html 200\n',
  }));
  assert.ok(findingFor(report.findings, 'competing-headers-file'));
  assert.ok(findingFor(report.findings, 'competing-redirects-file'));
});

test('findings are ordered blockers first', async () => {
  const root = await makeTree({
    ...minimalTree,
    'dist/assets/app.js': 'const k = "sk-LIVE0123456789abcdefghij";',
    '.gitignore': 'node_modules/\n',
  });
  const report = await auditRepository(root);
  const severities = report.findings.map((finding) => finding.severity);
  const rank = { blocker: 0, warning: 1, external: 2, info: 3 };
  const ranks = severities.map((severity) => rank[severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});
