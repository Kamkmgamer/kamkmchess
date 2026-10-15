import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'evidence');
const files = ['chrome.json', 'edge.json', 'chrome-cors-controls.json', 'edge-cors-controls.json'];
const runs = await Promise.all(files.map(async file => ({file, data: JSON.parse(await readFile(join(root, file), 'utf8'))})));
const server = (await readFile(join(root, 'server-requests.ndjson'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
const rows = runs.flatMap(run => {
  if (run.data.error || !run.data.completedAt) throw new Error(`Incomplete run: ${run.file}`);
  return run.data.probes.flatMap(probe => probe.rows.map(row => ({...row, browser: run.data.browser, sourceOrigin: probe.sourceOrigin, scope: probe.scope, permissionStates: probe.permissions})));
});
if (new Set(rows.map(row => row.case)).size !== rows.length) throw new Error('Duplicate case IDs');
const counts = {};
for (const row of rows) {
  const outcome = row.readable ? String(row.status) : 'fetch-failed';
  counts[outcome] = (counts[outcome] || 0) + 1;
  const actual = server.filter(record => record.case === row.case && record.method === row.method);
  if (row.readable && (actual.length !== 1 || actual[0].status !== row.status)) throw new Error(`Browser/server disagreement: ${row.case}`);
}
const denied = rows.filter(row => row.case.includes('loopback-denied'));
for (const row of denied) {
  if (row.readable || server.some(record => record.case === row.case)) throw new Error(`Denied loopback reached server: ${row.case}`);
  if (!row.permissionStates.every(permission => permission.state === 'denied')) throw new Error(`Permission was not denied: ${row.case}`);
}
const wildcardAuthorization = rows.filter(row => row.scope === 'baseline' && row.requestHeaderNames.includes('Authorization') && !row.case.includes('loopback-denied'));
for (const row of wildcardAuthorization) {
  const options = server.find(record => record.case === row.case && record.method === 'OPTIONS');
  const cors = options?.response_cors || {};
  if (!row.readable || row.status !== 200 || cors['Access-Control-Allow-Headers'] !== '*' || !options.access_control_request_headers.includes('authorization')) throw new Error(`Wildcard observation not corroborated: ${row.case}`);
}
const restrictedAuthorization = rows.filter(row => row.scope === 'restricted' && row.requestHeaderNames.includes('Authorization'));
for (const row of restrictedAuthorization) {
  if (row.readable || server.some(record => record.case === row.case && record.method === row.method)) throw new Error(`Restricted Authorization unexpectedly reached handler: ${row.case}`);
}
const blockedOrigin = rows.filter(row => row.scope === 'blocked-origin');
for (const row of blockedOrigin) {
  if (row.readable || server.some(record => record.case === row.case && record.method === row.method)) throw new Error(`Wrong origin unexpectedly reached handler: ${row.case}`);
}
const summary = {
  generatedAt: new Date().toISOString(), upstreamVersion: 'v8.0.30', upstreamCommit: '5be2cdab0869cbaa3d401891f740aebf7e15aa99',
  runs: runs.map(run => ({file: run.file, browser: run.data.protocolVersion.Browser, startedAt: run.data.startedAt, completedAt: run.data.completedAt, cases: run.data.probes.reduce((n, p) => n + p.rows.length, 0)})),
  totalCases: rows.length, outcomes: counts, serverRequestRecords: server.length,
  deniedLoopbackCasesWithNoServerRequest: denied.length,
  wildcardAuthorizationSuccessesCorroboratedByPreflight: wildcardAuthorization.length,
  restrictedAuthorizationBlocked: restrictedAuthorization.length, wrongOriginBlocked: blockedOrigin.length,
  readableSyntheticSSECompletions: rows.filter(row => row.syntheticSSEComplete).length,
  note: 'Transport observations from real pinned CORS/auth middleware with synthetic API handlers. Expected rejection controls are not product failures. No provider generation or live model compatibility was tested.'
};
await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
