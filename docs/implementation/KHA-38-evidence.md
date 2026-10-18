# KHA-38 implementation evidence

## Fixture evidence

Method: `pnpm exec vitest run src/opponents/service.test.ts` with injected in-memory connection-store behavior and fake HTTP/stream responses.

Expected and observed:

- One explicit diagnostic produces one POST, preserves the requested ID, separately captures the provider-reported alias, checks the fixed `e2e4` exercise, and only passes when the unique prior-plan token and unique response marker match. The plan token is present in the synthetic prior assistant record and absent from the latest user request.
- Exact ID validation preserves punctuation and case and rejects surrounding whitespace. Selection fails without a current exact configuration/credential/session pass.
- Candidate staging replaces queued candidates, leaves committed attribution unchanged, cancels when the still-current committed opponent is reselected, blocks an uninterpretable first candidate response, and commits only an interpretable first response for application by the controller.
- An injected provider instruction and false marker do not pass. A transport exception is a temporary failure after one request attempt and does not trigger a hidden retry. A missing local credential is a zero-request temporary failure.
- Catalog pagination returns every advertised page. A rate-limited refresh preserves prior IDs as stale, exposes the cooldown, and a refresh inside that cooldown sends no additional request. An exact manual ID already present in the catalog is not duplicated in `manualIds`.

Observed result: 7 tests passed in the opponent fixture file. The test does not call a live provider or certify any model, route, account, backend, cache, or chess ability.

## Local static checks

- `pnpm exec eslint src/opponents --max-warnings 0`: passed.
- `pnpm exec tsc -p tsconfig.app.json --noEmit`: no diagnostics in `src/opponents/**`; the repository check currently fails in other concurrently edited areas (`src/accounts/**`, `src/cloud/**`, `src/proofs/**`, `src/ui/**`, and a history integration test). These workspace issues were not changed in this implementation.

## Remaining integration and acceptance work

- The service returns a candidate identity that still must be applied atomically by a serialized controller intent. The current `GameController` has no model-switch intent, so KHA-38's committed/queued/producing/failed controller lifecycle and Stop/Undo/expiry/ownership fences are not complete here. Do not treat `setCommittedSelection` as controller persistence.
- This service binds evidence to profile configuration revision, credential revision, exact requested ID, protocol, and in-memory session. The diagnostic request options are fixed. A provider's internal alias/backend can still change without reporting it; reported IDs are observations only. Persisted generation-option, adapter-version, and post-reload/device evidence integration remains for composition/controller work.
- No native browser/assistive-technology or authorized live-provider evidence is recorded. `docs/spec/mvp-acceptance.json` MOD-01 through MOD-07 and HIS-02 remain `not_run`.
