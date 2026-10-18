// Local, offline readiness audit for deployment and operations.
//
// It answers one question from files only: "would shipping the current tree
// violate a boundary the specification names?" It never makes a network
// request, never reads a secret, never provisions anything and never claims
// that a deployed, native or live-provider run passed. Every check either
// passes on the real artifact, or reports a finding with the file that caused
// it, or reports an external gap that only an operator run can close.
//
// Usage:
//   node scripts/release/readiness-audit.mjs [--root DIR] [--json]
//   node scripts/release/readiness-audit.mjs --canary <token>
//
// --canary plants a synthetic secret in memory and proves the scanner detects
// it, so a clean bundle scan is not mistaken for a scanner that never matches.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

/**
 * @typedef {'blocker'|'warning'|'external'|'info'} Severity
 * @typedef {{ severity: Severity, code: string, message: string, file: string|null, remediation: string|null }} Finding
 * @typedef {{ tool: string, mode: string, disclaimer: string, status: string, counts: SeverityCounts, findings: Finding[] }} AuditReport
 * @typedef {{ blocker: number, warning: number, info: number, external: number }} SeverityCounts
 * @typedef {{ source?: string, destination?: string }} HostRule
 * @typedef {{ headers?: { key?: string, value?: string }[] }} HeaderRule
 * @typedef {{ headers?: HeaderRule[], rewrites?: HostRule[], cleanUrls?: boolean }} VercelConfig
 */

/** @satisfies {Record<string, Severity>} */
const SEVERITY = { BLOCKER: 'blocker', WARNING: 'warning', INFO: 'info', EXTERNAL: 'external' };
/** @satisfies {Record<Severity, number>} */
const SEVERITY_ORDER = { blocker: 0, warning: 1, external: 2, info: 3 };

/** Server-only names that must never be embedded in the browser distribution. */
const SERVER_ONLY_NAMES = [
  'DATABASE_URL',
  'CLERK_SECRET_KEY',
  'CLERK_SECRET',
  'CLERK_ISSUER',
  'CLERK_JWKS_URL',
  'CLERK_AUTHORIZED_PARTIES',
  'CLOUD_STORAGE_ENABLED',
  'KHA_BACKUP_PASSPHRASE',
  'PGPASSWORD',
  'PGHOST',
];

/** Direct AI provider hosts the browser is allowed to reach, for CSP review. */
const PROVIDER_HOSTS = ['api.openai.com', 'openrouter.ai', 'api.anthropic.com'];

/** Synthetic secret shapes. No real credential is ever written into this file. */
const SECRET_PATTERNS = [
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'anthropic-style-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { id: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/ },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'connection-string', pattern: /postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@[^\s"']+/ },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.txt', '.map', '.webmanifest']);

/**
 * @param {Severity} severity
 * @param {string} code
 * @param {string} message
 * @param {string|null} [file]
 * @param {string|null} [remediation]
 * @returns {Finding}
 */
function finding(severity, code, message, file, remediation) {
  return { severity, code, message, file: file ?? null, remediation: remediation ?? null };
}

/** @param {string} path @returns {Promise<string|null>} */
async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** @param {string} path @returns {Promise<boolean>} */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} directory
 * @param {Set<string>|null} [extensions]
 * @returns {Promise<string[]>}
 */
async function walk(directory, extensions) {
  /** @type {string[]} */
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(path, extensions ?? null)));
    } else if (!extensions || extensions.has(extensionOf(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

/** @param {string} name @returns {string} */
function extensionOf(name) {
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

/**
 * scanText returns the secret pattern ids found in one text body.
 * @param {string} text
 * @returns {string[]}
 */
export function scanText(text) {
  const hits = [];
  for (const { id, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      hits.push(id);
    }
  }
  return hits;
}

/**
 * scanServerOnlyNames returns the server-only configuration names in a body.
 * @param {string} text
 * @returns {string[]}
 */
export function scanServerOnlyNames(text) {
  return SERVER_ONLY_NAMES.filter((name) => text.includes(name));
}

/**
 * selfCheckCanary proves the scanner matches a planted value.
 * @param {string} token
 * @returns {{ token: string, detected: boolean, matchedRules: string[] }}
 */
export function selfCheckCanary(token) {
  const probe = `const leaked = "${token}";`;
  const matchedRules = scanText(probe);
  return { token, detected: matchedRules.length > 0, matchedRules };
}

/**
 * auditDistribution checks the built browser bundle in dist/.
 * @param {string} root
 * @param {Finding[]} findings
 * @returns {Promise<void>}
 */
async function auditDistribution(root, findings) {
  const dist = join(root, 'dist');
  if (!(await exists(dist))) {
    findings.push(finding(
      SEVERITY.WARNING,
      'dist-missing',
      'No dist/ directory, so the shipped bundle, notices and secret scan were not reviewed.',
      'dist',
      'Run `pnpm run build` and re-run this audit against the exact candidate build.',
    ));
    return;
  }

  for (const required of ['index.html', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'DEPENDENCY_INVENTORY.json']) {
    if (!(await exists(join(dist, required)))) {
      findings.push(finding(
        SEVERITY.BLOCKER,
        'dist-notice-missing',
        `The distribution does not contain ${required}.`,
        `dist/${required}`,
        'The build writes LICENSE.txt, THIRD_PARTY_NOTICES.txt and DEPENDENCY_INVENTORY.json; rebuild and re-check.',
      ));
    }
  }

  const files = await walk(dist, TEXT_EXTENSIONS);
  let secretHits = 0;
  let nameHits = 0;
  for (const file of files) {
    const text = await readText(file);
    if (text === null) continue;
    const id = relative(root, file).split(sep).join('/');
    const secrets = scanText(text);
    if (secrets.length > 0) {
      secretHits += secrets.length;
      findings.push(finding(
        SEVERITY.BLOCKER,
        'bundle-secret-pattern',
        `The bundle matches ${secrets.join(', ')}, which is a credential or connection-string shape.`,
        id,
        'Remove the value from the browser build. AI keys must never be compiled into the bundle.',
      ));
    }
    const names = scanServerOnlyNames(text);
    if (names.length > 0) {
      nameHits += names.length;
      findings.push(finding(
        SEVERITY.BLOCKER,
        'bundle-server-config',
        `The bundle contains server-only configuration name(s): ${names.join(', ')}.`,
        id,
        'Keep server configuration out of Vite client code. vite.config.ts sets envPrefix to []; keep it that way.',
      ));
    }
  }
  if (secretHits === 0 && nameHits === 0) {
    findings.push(finding(
      SEVERITY.INFO,
      'bundle-scan-clean',
      `Scanned ${files.length} distributable text files: no credential shape and no server-only configuration name.`,
      'dist',
      null,
    ));
  }

  const notices = await readText(join(dist, 'THIRD_PARTY_NOTICES.txt'));
  if (notices !== null) {
    if (!/MIT/.test(notices) || !/CC BY-SA/.test(notices) || !/Cburnett/.test(notices)) {
      findings.push(finding(
        SEVERITY.BLOCKER,
        'license-credit-missing',
        'Third-party notices do not carry the required MIT original-code notice and CC BY-SA art credit.',
        'dist/THIRD_PARTY_NOTICES.txt',
        'scripts/write-notices.mjs generates these sections; fix the generator, not the artifact.',
      ));
    }
  }

  const inventoryText = await readText(join(dist, 'DEPENDENCY_INVENTORY.json'));
  if (inventoryText !== null) {
    let inventory = null;
    try {
      inventory = JSON.parse(inventoryText);
    } catch {
      findings.push(finding(SEVERITY.BLOCKER, 'inventory-unparsable', 'DEPENDENCY_INVENTORY.json is not valid JSON.', 'dist/DEPENDENCY_INVENTORY.json', 'Rebuild.'));
    }
    if (inventory) {
      if (!inventory.lockfileVersion) {
        findings.push(finding(SEVERITY.WARNING, 'inventory-lockfile', 'The dependency inventory does not record a pnpm lockfile version.', 'dist/DEPENDENCY_INVENTORY.json', 'Regenerate from pnpm-lock.yaml.'));
      }
      const packages = Array.isArray(inventory.packages) ? inventory.packages : [];
      for (const entry of packages) {
        const license = String(entry?.license ?? '');
        if (!license) {
          findings.push(finding(SEVERITY.WARNING, 'license-undeclared', `${entry?.path ?? 'a package'} declares no license.`, 'dist/DEPENDENCY_INVENTORY.json', 'Review the license before distribution.'));
        } else if (/\b(AGPL|GPL|NonCommercial|Non-Commercial|SSPL)\b/i.test(license)) {
          findings.push(finding(SEVERITY.BLOCKER, 'license-excluded', `${entry?.path} is ${license}, which the distribution excludes.`, 'dist/DEPENDENCY_INVENTORY.json', 'Remove the dependency from production or obtain a compatible license.'));
        }
      }
    }
  }
}

/**
 * auditDeploymentConfiguration reviews vercel.json against the served routes.
 * @param {string} root
 * @param {Finding[]} findings
 * @returns {Promise<Record<string, unknown>|void>}
 */
async function auditDeploymentConfiguration(root, findings) {
  const path = join(root, 'vercel.json');
  const text = await readText(path);
  if (text === null) {
    findings.push(finding(SEVERITY.BLOCKER, 'vercel-config-missing', 'vercel.json is missing, so no host policy is reviewed.', 'vercel.json', 'Commit a reviewed host configuration.'));
    return {};
  }
  let config;
  try {
    config = /** @type {VercelConfig} */ (JSON.parse(text));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    findings.push(finding(SEVERITY.BLOCKER, 'vercel-config-unparsable', `vercel.json is not valid JSON: ${reason}`, 'vercel.json', 'Fix the configuration file.'));
    return {};
  }

  const csp = (config.headers ?? [])
    .flatMap((entry) => entry.headers ?? [])
    .find((header) => header.key?.toLowerCase() === 'content-security-policy')?.value ?? '';
  if (!csp) {
    findings.push(finding(SEVERITY.BLOCKER, 'csp-missing', 'No Content-Security-Policy header is configured.', 'vercel.json', 'Restore the reviewed CSP.'));
  } else {
    const directives = new Map(csp.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values.filter(Boolean)];
    }));
    // Directive values keep their quotes so a finding quotes the exact policy
    // text; comparisons strip them because "'self'" and "self" are the same source.
    /** @param {string[]} values @returns {string[]} */
    const bare = (values) => values.map((value) => value.replace(/^'|'$/g, ''));
    const connect = directives.get('connect-src') ?? [];
    const script = bare(directives.get('script-src') ?? []);
    const worker = bare(directives.get('worker-src') ?? []);

    const httpsAllowed = connect.includes('https:') || PROVIDER_HOSTS.every((host) => bare(connect).includes(`https://${host}`));
    if (!httpsAllowed) {
      findings.push(finding(
        SEVERITY.BLOCKER,
        'csp-connect-blocks-provider',
        `connect-src (${connect.join(' ') || 'absent'}) blocks direct browser provider generation.`,
        'vercel.json',
        "Allow https: or list the exact provider origins, for example https://api.openai.com https://openrouter.ai https://api.anthropic.com.",
      ));
    } else {
      findings.push(finding(
        SEVERITY.INFO,
        'csp-connect-allows-provider',
        `connect-src allows public HTTPS provider routes (${connect.join(' ')}).`,
        'vercel.json',
        null,
      ));
    }

    if (bare(connect).some((value) => /^http:\/\/(?!localhost|127\.0\.0\.1)/.test(value))) {
      findings.push(finding(SEVERITY.BLOCKER, 'csp-connect-allows-plain-http', 'connect-src allows cleartext HTTP to a non-loopback host.', 'vercel.json', 'Keep cleartext limited to loopback research routes.'));
    }
    for (const directive of ['unsafe-inline', 'unsafe-eval']) {
      if (script.includes(directive)) {
        findings.push(finding(SEVERITY.BLOCKER, 'csp-script-unsafe', `script-src contains ${directive}.`, 'vercel.json', 'Serve scripts as files and keep the policy restrictive.'));
      }
    }
    if (!worker.includes('self')) {
      findings.push(finding(SEVERITY.BLOCKER, 'csp-worker-missing', "worker-src does not allow the application's own Worker.", 'vercel.json', "Add worker-src 'self' so the adjudication Worker can start."));
    }
    if ((bare(directives.get('object-src') ?? [])[0]) !== 'none' || (bare(directives.get('base-uri') ?? [])[0]) !== 'none') {
      findings.push(finding(SEVERITY.WARNING, 'csp-base-weak', 'object-src or base-uri is not locked to none.', 'vercel.json', "Set object-src 'none' and base-uri 'none'."));
    }
    if (!directives.has('frame-ancestors')) {
      findings.push(finding(SEVERITY.WARNING, 'csp-frame-ancestors', 'frame-ancestors is not set.', 'vercel.json', "Add frame-ancestors 'none'."));
    }
  }

  const rewrites = config.rewrites ?? [];
  const sources = rewrites.map((rewrite) => rewrite.source);
  const apiSource = sources.find((source) => source?.startsWith('/v1'));
  if (!apiSource) {
    findings.push(finding(SEVERITY.BLOCKER, 'api-route-unrouted', 'No rewrite routes the Go storage API paths (/v1/*) to a function.', 'vercel.json', 'Add a rewrite from /v1/:path* to the Go function entry point.'));
  }

  const apiRoutes = await collectApiRoutes(root);
  if (apiSource && apiRoutes.length > 0) {
    const covered = apiSource.includes(':path*');
    findings.push(finding(
      covered ? SEVERITY.INFO : SEVERITY.BLOCKER,
      'api-route-coverage',
      `${covered ? 'The' : 'No'} rewrite covers the ${apiRoutes.length} owner-scoped API route(s) declared in backend/httpapi/api.go: ${apiRoutes.join(', ')}.`,
      'backend/httpapi/api.go',
      covered ? null : 'Route every API prefix or each route returns the SPA document instead of JSON.',
    ));
  }

  const clerkRouted = sources.some((source) => /sign-(in|up)/.test(source ?? ''));
  findings.push(finding(
    clerkRouted ? SEVERITY.INFO : SEVERITY.WARNING,
    'clerk-callback-routing',
    clerkRouted
      ? 'Sign-in and sign-up callback paths are routed back to the SPA document.'
      : 'No Clerk callback rewrite is configured, so a completed OAuth redirect would not reach the app.',
    'vercel.json',
    clerkRouted ? null : 'Add rewrites for the configured Clerk callback paths.',
  ));

  const spaFallback = sources.some((source) => source === '/' || source === '/(.*)') || Boolean(config.cleanUrls) || Boolean(config.rewrites?.length && sources.includes('/(.*)'));
  if (!spaFallback && !sources.some((source) => source?.includes(':path*'))) {
    findings.push(finding(SEVERITY.WARNING, 'spa-fallback', 'No SPA fallback rewrite is configured for deep links.', 'vercel.json', 'Add a catch-all rewrite to /index.html so a direct board URL does not 404.'));
  }

  await auditCompetingHostFiles(root, findings);
  return config;
}

/**
 * auditCompetingHostFiles reports a second, unreviewed host policy that would
 * silently disagree with vercel.json on some static hosts. These files are not
 * edited here: the owner of the deployment configuration decides.
 * @param {string} root
 * @param {Finding[]} findings
 * @returns {Promise<void>}
 */
async function auditCompetingHostFiles(root, findings) {
  for (const name of ['_headers', '_redirects']) {
    for (const directory of ['public', 'dist']) {
      const path = join(root, directory, name);
      const text = await readText(path);
      if (text === null) continue;
      const id = `${directory}/${name}`;
      if (name === '_headers') {
        findings.push(finding(
          SEVERITY.WARNING,
          'competing-headers-file',
          `${id} carries a Content-Security-Policy that is not the Vercel configuration. Any static host that honours it serves a different policy than vercel.json.`,
          id,
          'Keep one authoritative host policy, or document which host each file serves.',
        ));
      } else {
        findings.push(finding(
          SEVERITY.WARNING,
          'competing-redirects-file',
          `${id} rewrites every path to /index.html. On a host that honours it, that also captures the /v1/* API paths. Vercel does not read this file.`,
          id,
          'Exclude the API prefix if this file is used, or remove the ambiguity.',
        ));
      }
    }
  }
}

/**
 * collectApiRoutes extracts the mux route patterns the Go API actually serves.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function collectApiRoutes(root) {
  const text = await readText(join(root, 'backend', 'httpapi', 'api.go'));
  if (text === null) return [];
  /** @type {Set<string>} */
  const routes = new Set();
  for (const match of text.matchAll(/mux\.HandleFunc\("([A-Z]+ [^"]+)"/g)) {
    const pattern = match[1]?.split(' ')[1];
    if (pattern) routes.add(pattern);
  }
  return [...routes].sort();
}

/**
 * auditServerBoundary reviews the Go server for credential and relay leakage.
 * @param {string} root
 * @param {Finding[]} findings
 * @returns {Promise<void>}
 */
async function auditServerBoundary(root, findings) {
  const goFiles = await walk(join(root, 'backend'), new Set(['.go']));
  goFiles.push(...(await walk(join(root, 'cmd'), new Set(['.go']))));
  goFiles.push(...(await walk(join(root, 'api'), new Set(['.go']))));
  const providerEnvironment = /(OPENAI|ANTHROPIC|OPENROUTER|GOOGLE|GEMINI|XAI|GROQ|MISTRAL|DEEPSEEK|KIMI)_(API_)?KEY/i;
  const providerHost = /api\.(openai|anthropic)\.com|openrouter\.ai/i;
  for (const file of goFiles) {
    const text = await readText(file);
    if (text === null) continue;
    const id = relative(root, file).split(sep).join('/');
    if (providerEnvironment.test(text)) {
      findings.push(finding(SEVERITY.BLOCKER, 'server-provider-key', 'The Go server references a model provider key.', id, 'AI credentials must never enter the hosted API.'));
    }
    if (providerHost.test(text)) {
      findings.push(finding(SEVERITY.BLOCKER, 'server-provider-relay', 'The Go server references a provider endpoint, which suggests a generation relay.', id, 'Generation is browser-direct; the API must never relay model requests.'));
    }
  }

  const api = await readText(join(root, 'backend', 'httpapi', 'api.go'));
  if (api !== null) {
    const handlers = (api.match(/func \(a \*API\) \w+\(w http\.ResponseWriter/g) ?? []).length;
    const guarded = (api.match(/auth\.Owner\(r\.Context\(\)\)/g) ?? []).length;
    if (handlers > 0 && guarded < handlers) {
      findings.push(finding(SEVERITY.BLOCKER, 'api-owner-guard', `${handlers - guarded} of ${handlers} API handlers do not read a verified owner from context.`, 'backend/httpapi/api.go', 'Every handler must resolve the owner from the Clerk-verified context before touching storage.'));
    } else if (handlers > 0) {
      findings.push(finding(SEVERITY.INFO, 'api-owner-guard', `All ${handlers} API handlers resolve a verified owner from context.`, 'backend/httpapi/api.go', null));
    }
  }
}

/**
 * auditAccountStorageGate checks the fail-closed hosted storage switch.
 * @param {string} root
 * @param {Finding[]} findings
 * @returns {Promise<void>}
 */
async function auditAccountStorageGate(root, findings) {
  const env = await readText(join(root, '.env.example'));
  if (env !== null) {
    const match = env.match(/^\s*CLOUD_STORAGE_ENABLED\s*=\s*(\S+)\s*$/m);
    const configured = match?.[1] ?? '';
    if (!match) {
      findings.push(finding(SEVERITY.BLOCKER, 'storage-gate-unset', 'CLOUD_STORAGE_ENABLED is not documented in .env.example.', '.env.example', 'Document the gate with a disabled default.'));
    } else if (configured.toLowerCase() === 'true') {
      findings.push(finding(SEVERITY.BLOCKER, 'storage-gate-enabled', 'CLOUD_STORAGE_ENABLED defaults to true, so provisioning would silently enable public account storage.', '.env.example', 'Default it to false until backup readiness and the owner release decision.'));
    } else {
      findings.push(finding(SEVERITY.INFO, 'storage-gate-closed', `CLOUD_STORAGE_ENABLED defaults to ${configured}; hosted account storage fails closed.`, '.env.example', null));
    }
  }
  const handler = await readText(join(root, 'api', 'index.go'));
  if (handler === null) {
    findings.push(finding(SEVERITY.INFO, 'hosted-function-absent', 'No hosted API function is present, so public account storage cannot be enabled from this tree.', 'api/index.go', null));
  } else if (!/CLOUD_STORAGE_ENABLED/.test(handler) || !/StatusServiceUnavailable/.test(handler)) {
    findings.push(finding(SEVERITY.BLOCKER, 'storage-gate-unenforced', 'The hosted function does not visibly enforce the account storage gate.', 'api/index.go', 'Return a generic 503 with no-store until the gate is enabled.'));
  } else {
    findings.push(finding(SEVERITY.INFO, 'storage-gate-enforced', 'The hosted function refuses requests until the account storage gate is enabled.', 'api/index.go', null));
  }
}

/**
 * auditBackupReadiness reports what only an operator run can still close.
 * @param {string} root
 * @param {Finding[]} findings
 * @returns {Promise<void>}
 */
async function auditBackupReadiness(root, findings) {
  const tooling = await exists(join(root, 'backend', 'backup', 'backup.go'));
  const cli = await exists(join(root, 'backend', 'backup', 'cmd', 'khabackup', 'main.go'));
  if (tooling && cli) {
    findings.push(finding(SEVERITY.INFO, 'backup-tooling-present', 'Encrypted logical backup tooling and the khabackup command are present.', 'backend/backup', null));
  } else {
    findings.push(finding(SEVERITY.BLOCKER, 'backup-tooling-missing', 'Encrypted backup tooling or its command is missing, so backups cannot be produced.', 'backend/backup', 'Implement the operator backup path before public account storage.'));
  }
  const rehearsal = await exists(join(root, 'docs', 'implementation', 'MVP-operations.md'));
  if (!rehearsal) {
    findings.push(finding(SEVERITY.WARNING, 'operations-doc-missing', 'No operations runbook documents backup, restore and retention limits.', 'docs/implementation/MVP-operations.md', 'Write the runbook with honest retention and recovery limits.'));
  }
  findings.push(finding(
    SEVERITY.EXTERNAL,
    'backup-rehearsal-hosted',
    rehearsal
      ? 'The runbook records a local rehearsal. No hosted rotation, private destination or scheduled run has been executed, and a local fixture cannot certify quota, pause or read-only recovery.'
      : 'No rehearsal proves that a restore reproduces chunks and checkpoints and reapplies deletion tombstones. Tooling existence is not evidence.',
    'docs/implementation/MVP-operations.md',
    'Run khabackup create, verify and restore --apply against the selected managed database and its private destination, and record the digests.',
  ));
}

/**
 * auditRepositoryHygiene checks the small set of pinned-file facts.
 * @param {string} root
 * @param {Finding[]} findings
 * @returns {Promise<void>}
 */
async function auditRepositoryHygiene(root, findings) {
  const gitignore = await readText(join(root, '.gitignore'));
  if (gitignore !== null && !/^\.env$/m.test(gitignore.split(/\r?\n/).map((line) => line.trim()).join('\n'))) {
    findings.push(finding(SEVERITY.BLOCKER, 'env-not-ignored', '.env is not ignored, so a local secret file could be committed.', '.gitignore', 'Ignore .env and .env.* and keep .env.example.'));
  }
  for (const required of ['pnpm-lock.yaml', 'go.sum', '.node-version']) {
    if (!(await exists(join(root, required)))) {
      findings.push(finding(SEVERITY.WARNING, 'pin-missing', `${required} is missing, so the reviewed pins cannot be reproduced.`, required, 'Commit the lockfile or version pin.'));
    }
  }
  const nodeVersion = await readText(join(root, '.node-version'));
  const pkg = await readText(join(root, 'package.json'));
  if (nodeVersion !== null && pkg !== null) {
    const engines = JSON.parse(pkg).engines?.node ?? '';
    const pinned = nodeVersion.trim();
    if (engines && !engines.includes(pinned)) {
      findings.push(finding(SEVERITY.WARNING, 'node-version-mismatch', `package.json requires ${engines} but .node-version pins ${pinned}.`, '.node-version', 'Align the declared engine range and the pinned version.'));
    }
  }
}

/**
 * auditIdentityBoundary checks that hosted sign-in can actually load. A Clerk
 * browser SDK needs script, connect and frame origins that a strict CSP must
 * name explicitly, so a missing SDK and a missing allowance are reported
 * separately from a deployed sign-in that works.
 * @param {string} root
 * @param {Finding[]} findings
 * @returns {Promise<void>}
 */
async function auditIdentityBoundary(root, findings) {
  const configText = await readText(join(root, 'vercel.json'));
  const config = configText === null ? null : /** @type {VercelConfig|null} */ (JSON.parse(configText));
  const csp = config === null
    ? ''
    : (config.headers ?? [])
      .flatMap((entry) => entry.headers ?? [])
      .find((header) => header.key?.toLowerCase() === 'content-security-policy')?.value ?? '';

  const manifest = await readText(join(root, 'package.json'));
  const dependency = manifest === null ? '' : (/@clerk\//.test(manifest) ? '@clerk' : '');
  let inBundle = Boolean(dependency);
  if (!inBundle) {
    for (const file of await walk(join(root, 'dist'), TEXT_EXTENSIONS)) {
      const text = await readText(file);
      if (text && /clerk\.accounts\.dev|@clerk\/|ClerkProvider|useAuth/.test(text)) {
        inBundle = true;
        break;
      }
    }
  }

  if (!inBundle) {
    findings.push(finding(
      SEVERITY.EXTERNAL,
      'clerk-browser-sdk-absent',
      'No Clerk browser SDK is present in the build or dependencies, and the CSP names no Clerk origin, so a hosted sign-in cannot complete in a browser.',
      'package.json',
      'Install the Clerk browser SDK and name its script, connect and frame origins in vercel.json before enabling accounts.',
    ));
    return;
  }
  if (!/clerk/i.test(csp)) {
    // Severity follows the account storage gate: with accounts switched off the
    // Clerk script is unreachable anyway, so this is a warning that must be
    // fixed before the gate opens; with the gate open it blocks the release.
    const gated = await accountStorageEnabled(root);
    findings.push(finding(
      gated ? SEVERITY.BLOCKER : SEVERITY.WARNING,
      'clerk-csp-missing',
      gated
        ? 'A Clerk browser SDK is present and hosted account storage is enabled, but the CSP names no Clerk origin, so the SDK cannot load.'
        : 'A Clerk browser SDK is present but the CSP names no Clerk origin. Hosted account storage is gated off, so this must be fixed before the gate opens.',
      'vercel.json',
      'Add the exact Clerk script, connect and frame origins to the CSP.',
    ));
    return;
  }
  findings.push(finding(SEVERITY.INFO, 'clerk-csp-allowed', 'The CSP names a Clerk origin for the browser SDK.', 'vercel.json', null));
}

/**
 * accountStorageEnabled reports the documented hosted storage default.
 * @param {string} root
 * @returns {Promise<boolean>}
 */
async function accountStorageEnabled(root) {
  const env = await readText(join(root, '.env.example'));
  const match = env === null ? null : env.match(/^\s*CLOUD_STORAGE_ENABLED\s*=\s*(\S+)\s*$/m);
  return match?.[1]?.toLowerCase() === 'true';
}

/**
 * auditRepository runs every check against one repository root.
 * @param {string} root
 * @returns {Promise<AuditReport>}
 */
export async function auditRepository(root) {
  /** @type {Finding[]} */
  const findings = [];
  await auditDistribution(root, findings);
  await auditDeploymentConfiguration(root, findings);
  await auditServerBoundary(root, findings);
  await auditIdentityBoundary(root, findings);
  await auditAccountStorageGate(root, findings);
  await auditBackupReadiness(root, findings);
  await auditRepositoryHygiene(root, findings);

  /** @type {SeverityCounts} */
  const counts = { blocker: 0, warning: 0, info: 0, external: 0 };
  for (const item of findings) counts[item.severity] = (counts[item.severity] ?? 0) + 1;
  return {
    tool: 'scripts/release/readiness-audit.mjs',
    mode: 'offline-files-only',
    disclaimer: 'This audit reads local files only. It performs no network request, provisions nothing and certifies no deployed, native, assistive-technology or live-provider run.',
    status: counts.blocker > 0 ? 'blocked' : counts.warning > 0 ? 'review' : 'clear',
    counts,
    findings: findings.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity)
      || a.code.localeCompare(b.code)
      || String(a.file).localeCompare(String(b.file))),
  };
}

/**
 * severityOrder sorts blockers before warnings, external gaps and notes.
 * @param {Severity} severity
 * @returns {number}
 */
function severityOrder(severity) {
  return SEVERITY_ORDER[severity] ?? 4;
}

/**
 * printReport renders the human-facing report.
 * @param {AuditReport} report
 * @returns {void}
 */
function printReport(report) {
  process.stdout.write(`readiness audit: ${report.status}\n`);
  for (const item of report.findings) {
    const where = item.file ? ` [${item.file}]` : '';
    process.stdout.write(`  ${item.severity.toUpperCase().padEnd(8)} ${item.code}${where}\n`);
    process.stdout.write(`           ${item.message}\n`);
    if (item.remediation) process.stdout.write(`           fix: ${item.remediation}\n`);
  }
  process.stdout.write(
    `\nblockers ${report.counts.blocker}, warnings ${report.counts.warning}, external gaps ${report.counts.external}, notes ${report.counts.info}\n`,
  );
  process.stdout.write(`${report.disclaimer}\n`);
}

/** @returns {Promise<void>} */
async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes('--canary')) {
    const index = arguments_.indexOf('--canary');
    const token = arguments_[index + 1];
    if (!token) throw new Error('--canary needs a synthetic token value');
    const result = selfCheckCanary(token);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.detected ? 0 : 1;
    return;
  }
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  if (!root) throw new Error('--root needs a directory');
  const report = await auditRepository(root);
  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report);
  }
  process.exitCode = report.counts.blocker > 0 ? 1 : 0;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/release/readiness-audit.mjs')) {
  await main();
}