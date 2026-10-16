# KHA-41 local SQL verification

## Run

From this directory, use Node 24.22.0 and npm 11.19.1:

    npm ci --ignore-scripts --no-audit --no-fund
    npm test

The runner loads the committed migration and sends the committed fixture to PostgreSQL without rewriting it.

## Pass conditions

The fixture has 132 assertion calls, uses no_plan() and finish(), and emits a plan after execution. The runner checks all of the following:

- The fixture contains exactly 132 assertion calls.
- pgTAP emits plan 1..132 and 132 assertion output lines.
- Every assertion line starts with ok. A not ok line, missing or incorrect plan, missing output, or SQL execution error fails the run.
- All 16 direct public-RPC probes pass.

Any failed condition sets a nonzero process exit code. The runner prints aggregate results and failing assertions. It does not save a fabricated TAP transcript.

## Local environment and dependencies

The runner starts embedded PGlite 0.5.10, which provides PostgreSQL 18.6 and pgcrypto. It opens no TCP listener and uses one connection. The bootstrap creates synthetic anon, authenticated, and service_role roles, synthetic users, and auth.uid() from synthetic JWT claims. It uses no project credentials, real accounts, hosted database, or live requests.

This optional developer subpackage has a separate lockfile. It pins @electric-sql/pglite 0.5.10 under Apache-2.0. The vendored pgTAP 1.3.3 extension bundle is 38,662 bytes. The official theory/pgtap source archive SHA-256 is 325ea79d0d2515bce96bce43f6823dcd3effbd6c54cb2a4d6c2384fffa3a14c7. The bundle SHA-256 is 1f0f4c4d874f76b6b66a0e88ec1f4a78a26c1cdb1c8db2c38918ca8ee2de8ea3. pgTAP's install SQL identifies its revised FreeBSD license. The bundle remains vendored with its checksum check in the runner.

These packages are not in the application package or browser bundle. The [dependency inventory](../../../docs/dependency-notices.md) records their license and scope.

## Recorded run

The passing run was performed in the separate local SQL lane and recorded with source evidence commit 8de98a3157102bad80a3dd17751922bc60e4beea. It ran fixture revision f8a8b2013e25c155319923f436107d30a1ed947a from the source snapshot at 95c52b89ac5db86333c5a693f494a0b4750c2f76. The recorded environment was Node 24.22.0, npm 11.19.1, PGlite 0.5.10, PostgreSQL 18.6 WASM, emcc 6.0.5, pgcrypto, and pgTAP 1.3.3. The result was 132/132 pgTAP assertions, plan 1..132, 16/16 direct RPC probes, and exit code 0.

This publication candidate did not rerun the SQL lane. The [evidence report](../../../docs/implementation/KHA-41-local-evidence.md) and [machine-readable receipt](../../../docs/evidence/kha-41-local-sql-verification.json) record the prior observations, hashes, and limits. The receipt does not include raw TAP output because it was not retained.

The history includes earlier fixture and migration failures. The final fixture-only changes fixed request Base64 line wrapping, helper overload selection, role context for private metadata checks, a practice-result assertion that read through JSON text, and JSON null and public error expectations. The production migration did not change after its bd031 stalemate-result correction. See the evidence report for the failure sequence and hashes.

## Scope limits

Roles, users, and claims are synthetic. A single embedded connection cannot verify concurrent advisory-lock races. This local SQL run does not verify hosted two-account denial, deployed direct-table-write bypass, backup restore, native behavior, assistive technology, or the complete product acceptance suite. All 79 product acceptance checks remain not run. KHA-41 still needs the KHA-28 client adapter and deployed checks. It does not provide the KHA-42/43 browser integration.
