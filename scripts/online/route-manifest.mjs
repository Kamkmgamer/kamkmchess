// The route manifest of the online surface.
//
// The manifest is the route contract of the operational tooling. It names the
// routes the tooling probes, and the tooling compares the manifest with the
// routes the production code registers. A route the production code does not
// register is reported as `not_implemented`, and a scenario that depends on
// such a route is never counted as a passed acceptance scenario.
//
// The manifest never enables a route. The comparison is made against the
// repository, so it proves what the code registers and nothing about a
// deployed host.
//
// Usage:
//   node scripts/online/route-manifest.mjs [--root DIR] [--json] [--base-url URL]

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { goFunctions, stripGoComments } from './backup-coverage.mjs';

/** The manifest of the route contract. */
export const ROUTE_MANIFEST_FILE = 'scripts/online/online-routes.json';

/** The document that states the route contract. */
export const ROUTE_CONTRACT_FILE = 'docs/architecture/online-operations-contract.md';

/** The methods a route may use. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/**
 * @typedef {'implemented'|'not_implemented'|'disabled'|'not_probed'|'unknown'} RouteStatus
 * @typedef {{id: string, method: string, path: string, family: string, state: string}} Route
 */

/**
 * Replaces the placeholders of a path, so two paths that name the same
 * parameter in a different spelling compare equal.
 * @param {string} path
 * @returns {string}
 */
export function normalizeRoutePath(path) {
  return path.replace(/\{[^}]*\}/g, '{}');
}

/**
 * The key of a route.
 * @param {{method: string, path: string}} route
 * @returns {string}
 */
function routeKey(route) {
  return `${route.method} ${normalizeRoutePath(route.path)}`;
}

/**
 * Checks that the manifest is well formed.
 *
 * A manifest nobody can read is not a contract, so every field the tooling
 * relies on has to be there.
 * @param {any} manifest
 * @returns {string[]}
 */
export function validateRouteManifest(manifest) {
  /** @type {string[]} */
  const problems = [];
  if (!manifest || typeof manifest !== 'object') return ['the manifest is not an object'];
  if (!Number.isInteger(manifest.manifestVersion)) problems.push('the manifest records no version');
  if (typeof manifest.provisional !== 'boolean') problems.push('the manifest does not record whether it is provisional');
  if (!Array.isArray(manifest.routes) || manifest.routes.length === 0) {
    problems.push('the manifest names no route');
    return problems;
  }
  const ids = new Set();
  const keys = new Set();
  for (const route of manifest.routes) {
    if (!route || typeof route !== 'object') {
      problems.push('a route of the manifest is not an object');
      continue;
    }
    for (const field of ['id', 'method', 'path', 'family', 'state']) {
      if (typeof route[field] !== 'string' || route[field].trim() === '') {
        problems.push(`a route of the manifest has no ${field}`);
      }
    }
    if (typeof route.method === 'string' && !METHODS.includes(route.method)) {
      problems.push(`the route ${route.id} uses the unknown method ${route.method}`);
    }
    if (typeof route.path === 'string' && !route.path.startsWith('/')) {
      problems.push(`the route ${route.id} has no absolute path`);
    }
    if (typeof route.id === 'string' && route.id !== '') {
      if (ids.has(route.id)) problems.push(`the route ${route.id} is named twice`);
      ids.add(route.id);
    }
    if (typeof route.method === 'string' && typeof route.path === 'string') {
      const key = routeKey(route);
      if (keys.has(key)) problems.push(`the route ${route.id} is the same route as another one`);
      keys.add(key);
    }
  }
  return problems;
}

/**
 * Reads the manifest of the repository.
 * @param {string} root
 * @returns {Promise<{manifest: any, problems: string[]}>}
 */
export async function loadRouteManifest(root) {
  const file = join(root, ...ROUTE_MANIFEST_FILE.split('/'));
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  return { manifest, problems: validateRouteManifest(manifest) };
}

/**
 * The routes of a manifest.
 * @param {any} manifest
 * @returns {Route[]}
 */
export function manifestRoutes(manifest) {
  if (!Array.isArray(manifest?.routes)) return [];
  return manifest.routes.map((route) => ({
    id: String(route.id ?? ''),
    method: String(route.method ?? ''),
    path: String(route.path ?? ''),
    family: String(route.family ?? ''),
    state: String(route.state ?? ''),
  }));
}

/**
 * Reads the routes the production code registers.
 *
 * Only the leaf registrations count: a handler that is mounted under a prefix
 * is not a route of its own, and a route that is not registered is a route the
 * service does not serve.
 * @param {string} root
 * @returns {Promise<{method: string, path: string}[]>}
 */
export async function scanProductionRoutes(root) {
  /** @type {{method: string, path: string}[]} */
  const routes = [];
  const pattern = /\bHandleFunc\(\s*"((?:GET|POST|PUT|PATCH|DELETE|OPTIONS)\s+)?(\/[^"]*)"/g;
  const walk = async (directory) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith('.go')) continue;
      if (entry.name.endsWith('_test.go')) continue;
      const text = await readFile(path, 'utf8');
      let match = pattern.exec(text);
      while (match !== null) {
        routes.push({ method: (match[1] ?? '').trim(), path: match[2] });
        match = pattern.exec(text);
      }
    }
  };
  await walk(join(root, 'backend'));
  await walk(join(root, 'cmd'));
  return routes;
}

/**
 * Compares the routes of the manifest with the routes the production code
 * registers.
 * @param {Route[]} routes
 * @param {{method: string, path: string}[]} productionRoutes
 * @returns {(Route & {status: RouteStatus})[]}
 */
export function routeCoverage(routes, productionRoutes) {
  return routes.map((route) => {
    const registered = productionRoutes.some((entry) => (
      normalizeRoutePath(entry.path) === normalizeRoutePath(route.path)
      && (entry.method === '' || entry.method === route.method)
    ));
    return { ...route, status: registered ? 'implemented' : 'not_implemented' };
  });
}

/**
 * Reads the route table of the contract document.
 *
 * The table has one row per route, so the document and the manifest can be
 * compared mechanically.
 * @param {string} text
 * @returns {{method: string, path: string, family: string}[]}
 */
export function contractRouteTable(text) {
  /** @type {{method: string, path: string, family: string}[]} */
  const routes = [];
  const pattern = /^\|\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS)\s*\|\s*(\/[^|]+?)\s*\|\s*([a-z][a-z-]*)\s*\|\s*$/gm;
  let match = pattern.exec(text);
  while (match !== null) {
    routes.push({ method: match[1], path: match[2], family: match[3] });
    match = pattern.exec(text);
  }
  return routes;
}

/**
 * Reads the provisional state the contract document claims for the manifest.
 * @param {string} text
 * @returns {boolean|null}
 */
export function contractProvisionalFlag(text) {
  const match = /provisional:\s*(true|false)/i.exec(text);
  if (!match) return null;
  return match[1].toLowerCase() === 'true';
}

/**
 * Compares the route table of the contract document with the manifest.
 * @param {{method: string, path: string, family: string}[]} contractRoutes
 * @param {Route[]} routes
 * @param {boolean|null} contractProvisional
 * @param {boolean} manifestProvisional
 * @returns {string[]}
 */
export function compareRouteContract(contractRoutes, routes, contractProvisional, manifestProvisional) {
  /** @type {string[]} */
  const problems = [];
  const contractKeys = new Set(contractRoutes.map((route) => routeKey(route)));
  const manifestKeys = new Set(routes.map((route) => routeKey(route)));
  for (const route of routes) {
    if (!contractKeys.has(routeKey(route))) {
      problems.push(`the manifest names ${route.method} ${route.path}, which the contract document does not list`);
    }
  }
  for (const route of contractRoutes) {
    if (!manifestKeys.has(routeKey(route))) {
      problems.push(`the contract document lists ${route.method} ${route.path}, which the manifest does not name`);
    }
  }
  if (contractProvisional === null) {
    problems.push('the contract document does not state whether the manifest is provisional');
  } else if (contractProvisional !== manifestProvisional) {
    problems.push(`the contract document states provisional: ${contractProvisional}, but the manifest records provisional: ${manifestProvisional}`);
  }
  return problems;
}

/**
 * Builds the pattern that finds a route in the source of a test.
 *
 * A placeholder matches one path segment, so the pattern finds the route in
 * a test that builds its path from a literal and a variable.
 * @param {string} path
 * @returns {RegExp}
 */
function routePattern(path) {
  const segments = path.split('/').map((segment) => (
    /^\{[^}]*\}$/.test(segment) ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ));
  return new RegExp(segments.join('/'));
}

/**
 * Reads the bodies of the test functions of a Go source.
 * @param {string} source
 * @returns {Map<string, string>}
 */
function testBodies(source) {
  /** @type {Map<string, string>} */
  const bodies = new Map();
  const withLiterals = stripGoComments(source, true);
  for (const fn of goFunctions(source).values()) {
    // The quotes are removed, so a path that is built from two literals and a
    // variable reads as one text the pattern can match.
    bodies.set(fn.name, withLiterals.slice(fn.start, fn.end).replace(/["'`]/g, ''));
  }
  return bodies;
}

/**
 * Reads which routes the acceptance scenarios depend on.
 *
 * The dependency is read from the tests themselves: a test that names a route
 * exercises it. Nothing is declared by hand, so the dependency cannot drift
 * away from the code.
 * @param {string} root
 * @param {{scenarios: Record<string, string[]>}} map
 * @param {Route[]} routes
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function routeDependencies(root, map, routes) {
  /** @type {Map<string, string>} */
  const bodies = new Map();
  const directory = join(root, 'backend', 'integration');
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('_test.go')) continue;
    const source = await readFile(join(directory, entry.name), 'utf8');
    for (const [name, body] of testBodies(source)) bodies.set(name, body);
  }
  const patterns = routes.map((route) => ({ route, pattern: routePattern(route.path) }));
  /** @type {Map<string, Set<string>>} */
  const dependencies = new Map();
  for (const [scenarioId, tests] of Object.entries(map.scenarios ?? {})) {
    /** @type {Set<string>} */
    const ids = new Set();
    for (const test of tests) {
      const body = bodies.get(test);
      if (!body) continue;
      for (const entry of patterns) {
        if (entry.pattern.test(body)) ids.add(entry.route.id);
      }
    }
    dependencies.set(scenarioId, ids);
  }
  return dependencies;
}

/**
 * Reports the scenarios that cannot be counted as passed.
 *
 * A scenario whose tests exercise a route the production code does not
 * register is not implemented, whatever the tests said.
 * @param {{scenarioId: string, status: string, detail: string}[]} coverage
 * @param {Map<string, Set<string>>} dependencies
 * @param {(Route & {status: RouteStatus})[]} routes
 * @returns {{scenarioId: string, status: string, detail: string}[]}
 */
export function applyRouteCoverage(coverage, dependencies, routes) {
  const missing = new Map(routes.filter((route) => route.status === 'not_implemented').map((route) => [route.id, route]));
  return coverage.map((entry) => {
    if (entry.status !== 'passed') return entry;
    const ids = dependencies.get(entry.scenarioId) ?? new Set();
    const absent = [...ids].map((id) => missing.get(id)).filter(Boolean);
    if (absent.length === 0) return entry;
    return {
      ...entry,
      status: 'not_implemented',
      detail: `${entry.detail}, but ${absent.map((route) => `${route.method} ${route.path}`).join(', ')} is not implemented`,
    };
  });
}

/**
 * Reads the feature state of a running service.
 * @param {string} baseUrl
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{friends: boolean, queue: boolean}|null>}
 */
async function readFeatures(baseUrl, fetchImpl) {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/online/features`);
    if (!response.ok) return null;
    const body = await response.json();
    return { friends: Boolean(body?.friends), queue: Boolean(body?.queue) };
  } catch {
    return null;
  }
}

/**
 * Reports whether a surface of the service is closed.
 * @param {{friends: boolean, queue: boolean}|null} features
 * @param {string} family
 * @returns {boolean}
 */
function surfaceClosed(features, family) {
  if (!features) return false;
  if (family === 'friend') return !features.friends;
  if (family === 'queue') return !features.queue;
  return false;
}

/**
 * Probes the routes of the manifest against a running service.
 *
 * Only the routes that read are probed: a probe of a route that mutates the
 * service would change the state the probe is supposed to observe.
 * @param {{baseUrl: string, routes: Route[], fetchImpl?: typeof fetch}} input
 * @returns {Promise<(Route & {status: RouteStatus, detail: string})[]>}
 */
export async function probeRoutes(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/$/, '');
  const features = await readFeatures(base, fetchImpl);
  /** @type {(Route & {status: RouteStatus, detail: string})[]} */
  const results = [];
  for (const route of input.routes) {
    if (route.method !== 'GET') {
      results.push({ ...route, status: 'not_probed', detail: 'the route writes, so it is not probed' });
      continue;
    }
    if (surfaceClosed(features, route.family)) {
      results.push({ ...route, status: 'disabled', detail: 'the surface of the route is closed' });
      continue;
    }
    const path = route.path.replace(/\{[^}]*\}/g, 'probe');
    try {
      const response = await fetchImpl(`${base}${path}`);
      const text = response.status === 404 ? await response.text() : '';
      // A router that does not know the path answers with its own page. A
      // route that exists and refuses the request answers with the error of
      // the service.
      const missing = response.status === 404 && /404 page not found/.test(text);
      results.push({
        ...route,
        status: missing ? 'not_implemented' : 'implemented',
        detail: missing ? 'the service does not serve the route' : `the service answered ${response.status}`,
      });
    } catch (error) {
      results.push({ ...route, status: 'unknown', detail: `the service could not be asked: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return results;
}

/**
 * Audits the route manifest of the repository.
 * @param {string} root
 * @returns {Promise<{manifest: any, routes: (Route & {status: RouteStatus})[], problems: string[], contractProvisional: boolean|null}>}
 */
export async function auditRouteManifest(root) {
  const { manifest, problems } = await loadRouteManifest(root);
  const routes = manifestRoutes(manifest);
  const productionRoutes = await scanProductionRoutes(root);
  const coverage = routeCoverage(routes, productionRoutes);
  let contractText = '';
  try {
    contractText = await readFile(join(root, ...ROUTE_CONTRACT_FILE.split('/')), 'utf8');
  } catch {
    problems.push(`the route contract ${ROUTE_CONTRACT_FILE} is missing`);
  }
  const contractRoutes = contractRouteTable(contractText);
  const contractProvisional = contractProvisionalFlag(contractText);
  problems.push(...compareRouteContract(contractRoutes, routes, contractProvisional, Boolean(manifest?.provisional)));
  for (const route of coverage) {
    if (route.status === 'not_implemented') {
      problems.push(`the production code does not register ${route.method} ${route.path}`);
    }
  }
  return { manifest, routes: coverage, problems, contractProvisional };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const rootIndex = arguments_.indexOf('--root');
  const root = rootIndex >= 0 ? arguments_[rootIndex + 1] : process.cwd();
  const report = await auditRouteManifest(root);
  const baseUrlIndex = arguments_.indexOf('--base-url');
  const baseUrl = baseUrlIndex >= 0 ? arguments_[baseUrlIndex + 1] : null;
  const probe = baseUrl ? await probeRoutes({ baseUrl, routes: report.routes }) : null;
  if (arguments_.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      tool: 'scripts/online/route-manifest.mjs',
      mode: 'repository-files-only',
      disclaimer: 'This audit reads the repository. It proves which routes the production code registers and nothing about a deployed host.',
      ...report,
      probe,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`route manifest: ${report.routes.length} routes, provisional: ${report.manifest?.provisional}\n`);
    for (const route of report.routes) {
      process.stdout.write(`  ${route.status.padEnd(16)} ${route.method.padEnd(6)} ${route.path}\n`);
    }
    if (probe) {
      process.stdout.write('\nlive probe:\n');
      for (const route of probe) {
        process.stdout.write(`  ${route.status.padEnd(16)} ${route.method.padEnd(6)} ${route.path} (${route.detail})\n`);
      }
    }
    if (report.problems.length > 0) {
      process.stdout.write('\nproblems:\n');
      for (const problem of report.problems) process.stdout.write(`  ! ${problem}\n`);
    }
  }
  if (report.problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/online/route-manifest.mjs')) {
  await main();
}
