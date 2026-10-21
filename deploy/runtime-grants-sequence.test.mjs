import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { auditGrants, parsePolicy, renderGrantSql } from './runtime-grants.mjs';

// The grant of the sequence of the health checkpoints.
//
// The order of the checkpoints comes from the default of the column, so the
// role that writes the health of the service needs the usage of the sequence
// and nothing else. The rules process holds no SQL privilege at all, so it
// never receives the usage.

const policy = parsePolicy(JSON.parse(readFileSync(new URL('./runtime-grants.policy.json', import.meta.url), 'utf8')));

test('the deployment grants the sequence of the checkpoints explicitly', () => {
  const sql = renderGrantSql(policy);
  assert.match(sql, /REVOKE ALL ON SEQUENCE public\.online_service_health_order FROM PUBLIC;/);
  assert.match(sql, /GRANT USAGE ON SEQUENCE public\.online_service_health_order TO kamkmchess_runtime;/);
});

test('the policy grants the usage of the sequence and nothing else', () => {
  assert.deepEqual(policy.sequences['online_service_health_order'], ['USAGE']);
});

test('the audit accepts the sequence of the policy', () => {
  const findings = auditGrants({
    policy,
    tables: [],
    usage: new Map(),
    sequences: ['online_service_health_order'],
  });
  const blockers = findings.filter((finding) => finding.severity === 'blocker');
  assert.deepEqual(blockers, []);
});

test('the audit refuses a sequence that the policy does not grant', () => {
  const findings = auditGrants({
    policy,
    tables: [],
    usage: new Map(),
    sequences: ['online_service_health_order', 'online_service_missing_order'],
  });
  assert.ok(findings.some((finding) => finding.code === 'sequence-missing-grant'));
});

test('the audit refuses an unknown privilege of a sequence', () => {
  const findings = auditGrants({
    policy: { ...policy, sequences: { online_service_health_order: ['USAGE', 'DROP'] } },
    tables: [],
    usage: new Map(),
    sequences: ['online_service_health_order'],
  });
  assert.ok(findings.some((finding) => finding.code === 'sequence-unknown-privilege'));
});

test('the audit refuses a policy entry for a sequence that no migration creates', () => {
  const findings = auditGrants({
    policy: { ...policy, sequences: { ...policy.sequences, online_service_absent_order: ['USAGE'] } },
    tables: [],
    usage: new Map(),
    sequences: ['online_service_health_order'],
  });
  assert.ok(findings.some((finding) => finding.code === 'sequence-unknown-entry'));
});
