# KHA-41 local SQL evidence

## Recorded execution

This report records a prior local SQL run, not a run in the publication candidate. The run evidence is source commit 8de98a3157102bad80a3dd17751922bc60e4beea. It used fixture revision f8a8b2013e25c155319923f436107d30a1ed947a. The migration, fixture, runner, configuration, and dependency files match the Git blobs in source integration commit 95c52b89ac5db86333c5a693f494a0b4750c2f76. The runner README was edited for public documentation. The [machine-readable receipt](../evidence/kha-41-local-sql-verification.json) lists each tested input Git blob and recorded file hash.

The run executed npm test from supabase/tests/local/. It applied the migration and sent the fixture exactly as stored, with no SQL rewriting. The runner observed 132 of 132 pgTAP assertions passing, the plan 1..132, and 16 of 16 direct public-RPC probes passing. The process exited with code 0. The fixture uses no_plan() and finish(); 132 is the assertion-call count, while 1..132 is the observed pgTAP plan.

The recorded environment was Node 24.22.0, npm 11.19.1, PGlite 0.5.10, PostgreSQL 18.6 on wasm32-unknown-emscripten, emcc 6.0.5 (1db513782be24469589d7cb8a1f1834e9a33f271), pgcrypto, and pgTAP 1.3.3. Roles, users, and JWT claims were synthetic. PGlite used one embedded connection and opened no listener.

The source execution record retained aggregate results, hashes, and failing-run history, but not the complete raw TAP output. This report does not invent that output.

## Direct RPC observations

| Probe | Observed |
| --- | --- |
| Sparse create at revision 31 with an epoch-zero checkpoint | Accepted revision 31 under cloud epoch 1 and preserved the exact checkpoint text. |
| Digest-bound create archive batch | One batch returned the submitted Base64 and SHA-256; sequence zero, gaps, and multibyte chunk bytes passed. |
| Sparse commit to revision 61 | Accepted revision 61 at cloud epoch 1 without creating intermediate rows. |
| First bounded read | Froze target revision 61 and epoch 1, returned the revision 31 batch, and reported more data. |
| Archive delta after the frozen target | Accepted revision 70 with event sequence 8 after 4 and chunk sequence 7 after 2. |
| Later page within the frozen target | Returned the revision 61 batch, excluded revision 70, and reported no more data. |
| Operation lookup | Found the revision 61 operation and returned found=false for an unknown operation. |
| Takeover | Advanced cloud epoch to 2 while preserving accepted revision 70 and checkpoint epoch 1. |
| Frozen read after takeover | Rejected the stale target with SQLSTATE 40001. |
| Epoch adoption | Accepted revision 75 at cloud epoch 2. |
| Pending create | Kept finalResult null. |
| Pending update | Accepted revision 10 and kept finalResult null. |
| Final-result latch | Accepted the draw stalemate result at revision 14. |
| Semantic final equality | Accepted reordered JSON with the same value at revision 16. |
| Changed final | Rejected the change with SQLSTATE 55000. |
| Delete and exact retry | Tombstone, operation lookup, and retry returned payload-free deletion receipts. |

## Hashes and source identity

The source integration commit and candidate use the same Git blobs for the copied SQL/configuration/runner tree. The recorded Windows SHA-256 values below are from the tested files.

| Input | Recorded SHA-256 |
| --- | --- |
| supabase/config.toml | 96f16eb51d4eea702ed47d9d25f2d9ce9024dc93565508fe170ab9a5b1a49f5e |
| supabase/migrations/20261016000100_owner_only_cloud_storage.sql | a85fda9bd9273c2b4f98fa02a2ca7d447aabba78041e3d473833fce3e2a462a3 |
| supabase/tests/kha41_cloud_storage.sql | 69d4259db4e816e6826361052fcfd0021345230bdf1733e24baf8e96380b1705 |
| supabase/tests/local/package-lock.json | 1660a3c5245c7d3a4cacfded08904a39fcd7cbfc3fc48195e0e06af5ed3c0e47 |
| supabase/tests/local/package.json | 52c763e994f01bf1e76a72358860c3165af5a55412ac0f3f29db677450619d95 |
| supabase/tests/local/run-kha41.mjs | 405e648e6d362f2940efbda46cec25f07b9aab3216928122033e4fe60596c115 |
| supabase/tests/local/vendor/pgtap-1.3.3.tar.gz | 1f0f4c4d874f76b6b66a0e88ec1f4a78a26c1cdb1c8db2c38918ca8ee2de8ea3 |

Git blob IDs hash repository-stored content. Windows file SHA-256 values hash the checked-out bytes. The runner file in this candidate was copied from the tested source checkout with LF endings, so its raw Windows hash matches the recorded 405e... value. A checkout configured to convert that file to CRLF will have a different raw file hash while retaining the same Git blob. Compare the Git blob or normalize line endings before comparing such checkouts.

The fixture helper strips CR and LF from Base64 request text. Separately, SQL decodes the request, checks SHA-256, and stores the decoded batch bytes. Batch readback, inner multibyte chunk bytes, and digests passed. The runner did not rewrite fixture SQL.

## Failure history

Earlier exact runs exposed real issues and fixture mismatches. The migration correction at bd031 renamed the local current_schema variable that shadowed PostgreSQL's current_schema function. That run also added the accepted rule that a stalemate result must have winner draw in checkpoint, practice, and final-result inputs. No later production migration change was needed.

The r4 production review found no blocking migration issue after that correction. Its remaining spec finding was fixture-only: a practice.originalResult assertion read through checkpoint payload text without parsing it. The final fixture parses the preserved payload text as JSONB before checking the nested result. This did not change the migration.

An earlier 5245 run stopped on a fixture syntax error before any of its 116 then-current assertions ran. Eight of nine direct probes passed; sparse commit exposed the current_schema name collision. Its migration SHA-256 was 95285b91e17d7796ccbeb476e9feb0e4899ac2325c425a4c5e77280d921a4f52 and fixture SHA-256 was 782ec806f4855eabc08d1fda04bf8557613ae092e0f3d4dbff39417948742124

The later 9ec fixture emitted all 132 assertion results: 122 passed and 10 failed. The failures covered wrapped Base64 request text, unresolved helper overloads, nested-field error wording, JSON null expectations, and a generic public conflict message. All 16 direct probes passed. The fixture had already moved protected metadata checks into the owner role. Its fixture SHA-256 was ea7986a2fa2a103e2bcef369bfd9da416766f57c34d16a588363219541d72b95

The final f8 fixture-only revision kept all 132 assertion calls and fixed those remaining request, helper, and expectation issues. It passed all 132 assertions and 16 direct probes. The production migration remained at SHA-256 a85fda9bd9273c2b4f98fa02a2ca7d447aabba78041e3d473833fce3e2a462a3; the final fixture SHA-256 was 69d4259db4e816e6826361052fcfd0021345230bdf1733e24baf8e96380b1705

## Limits

This result supports preparatory local SQL only. It does not certify the full KHA-41 issue or the product. All 79 product acceptance checks remain not run. No hosted two-account denial, deployed direct-table-write bypass, multi-session lock race, backup restore, native, or assistive-technology check ran. No hosted database, project credential, live request, or spend was used.

The migration is storage-only. It does not provide chess authority, AI key relay, or a TypeScript RPC adapter. KHA-28 integration and KHA-42/43 browser work remain separate. KHA-32 must define nonempty extension mappings before clients send them. SQL cannot scan opaque chunk bytes for credential values. The single-connection PGlite setup cannot prove cross-session lock ordering.

No frontend runtime files changed in this candidate. No static web build or full Vitest run was performed for this backend-only change.

## Artifacts

- [Local runner](../../supabase/tests/local/run-kha41.mjs)
- [Runner setup and pass conditions](../../supabase/tests/local/README.md)
- [Pinned local package lock](../../supabase/tests/local/package-lock.json)
- [pgTAP extension bundle](../../supabase/tests/local/vendor/pgtap-1.3.3.tar.gz)
- [Fixture](../../supabase/tests/kha41_cloud_storage.sql)
- [Migration](../../supabase/migrations/20261016000100_owner_only_cloud_storage.sql)
- [Machine-readable run receipt](../evidence/kha-41-local-sql-verification.json)
