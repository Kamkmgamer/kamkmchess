import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import { parsePolicy, renderGrantSql } from './runtime-grants.mjs';
import {
  INTENTIONAL_DEFENSIVE_REVOKES,
  auditProvisionStatements,
  captureProvisionSql,
  canonicalStatement,
  findPythonInterpreter,
  splitSqlStatements,
} from './runtime-grants-provision.mjs';

// The deployment renders the grants of the policy a second time.
//
// The provisioning routine is the script that runs on the server, so it is the
// renderer that decides what the runtime role holds in production. The gate
// below compares the statements it really emits with the statements of the
// reviewed renderer, which is rendered from the reviewed policy: a policy
// entry the deployment does not render is a blocker of the pull request.
//
// The capture runs the actual routine. The database call is a recorder, the
// migration subprocess and the change of the working directory are isolated
// and no grant is applied anywhere, so the gate needs no database and no
// container.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const policy = parsePolicy(JSON.parse(await readFile(join(root, 'deploy', 'runtime-grants.policy.json'), 'utf8')));
const rendered = splitSqlStatements(renderGrantSql(policy));
const statements = await captureProvisionSql({ root, python: findPythonInterpreter() });
const applied = new Set(statements.map(canonicalStatement));

/**
 * Returns the codes of the blockers of a set of statements.
 * @param {string[]} provision
 * @returns {string[]}
 */
function blockerCodes(provision) {
  return auditProvisionStatements({ provisionStatements: provision, renderedStatements: rendered })
    .filter((finding) => finding.severity === 'blocker')
    .map((finding) => finding.code);
}

test('the deployment applies every statement of the reviewed renderer', () => {
  assert.deepEqual(blockerCodes(statements), []);
});

test('the deployment grants the sequence of the checkpoints and takes it away first', () => {
  for (const sequence of Object.keys(policy.sequences)) {
    assert.ok(
      applied.has(`REVOKE ALL ON SEQUENCE public.${sequence} FROM ${policy.role}`),
      `the deployment does not take the sequence ${sequence} away from the runtime role`,
    );
    assert.ok(
      applied.has(`GRANT USAGE ON SEQUENCE public.${sequence} TO ${policy.role}`),
      `the deployment does not grant the usage of the sequence ${sequence}`,
    );
  }
});

test('the deployment strips the unused roles of the tables, the sequences, the functions and the schema', () => {
  for (const unused of policy.unusedRoles) {
    for (const statement of [
      `REVOKE ALL ON ALL TABLES IN SCHEMA ${policy.schema} FROM ${unused}`,
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${policy.schema} FROM ${unused}`,
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${policy.schema} FROM ${unused}`,
      `REVOKE ALL ON SCHEMA ${policy.schema} FROM ${unused}`,
    ]) {
      assert.ok(applied.has(statement), `the deployment does not apply ${statement}`);
    }
  }
});

test('the deployment takes the defaults of the objects away from PUBLIC', () => {
  for (const objectClass of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
    assert.ok(
      applied.has(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${policy.schema} REVOKE ALL ON ${objectClass} FROM PUBLIC`),
      `the deployment leaves the default privileges of the ${objectClass} with PUBLIC`,
    );
  }
});

test('the delta of the deployment is the reviewed list of the defensive revokes', () => {
  const renderedSet = new Set(rendered.map(canonicalStatement));
  const delta = [...applied].filter((statement) => !renderedSet.has(statement)).sort();
  assert.deepEqual(delta, [...INTENTIONAL_DEFENSIVE_REVOKES].sort());
});

test('a sequence grant that the deployment does not apply is a blocker', () => {
  const reduced = statements.filter((statement) => !statement.includes('ON SEQUENCE public.online_service_health_order TO kamkmchess_runtime'));
  assert.ok(blockerCodes(reduced).includes('provision-renderer-statement-missing'));
});

test('a table grant that the deployment does not apply is a blocker', () => {
  const reduced = statements.filter((statement) => !statement.includes('ON TABLE public.online_matches TO kamkmchess_runtime'));
  assert.ok(blockerCodes(reduced).includes('provision-renderer-statement-missing'));
});

test('a grant that the deployment applies and the policy does not carry is a blocker', () => {
  const widened = [...statements, 'GRANT SELECT ON TABLE public.online_matches TO kamkm_online_api;'];
  assert.ok(blockerCodes(widened).includes('provision-unreviewed-statement'));
});

test('a defensive revoke that the deployment no longer applies is a blocker', () => {
  const reduced = statements.filter((statement) => !statement.includes('ON ALL SEQUENCES IN SCHEMA public FROM kamkm_online_rules'));
  assert.ok(blockerCodes(reduced).includes('provision-defensive-revoke-missing'));
});
