# KHA-37 implementation evidence

The owner's 2026-10-18 [compact model input policy](../spec/compact-model-input.md) supersedes the full-history composition described in this original evidence. `composeMoveInput` now builds one chess-state message with the latest available plan and returned reasoning for the playing side. The archive path and usage accounting remain in place. Current fixtures verify all three destination encoders, current-turn feedback, custom starts and repetition state, archive preservation, and a request below 1 KB despite a saved raw transcript above 1 MB. Integration and browser fixtures verify that the latest thinking survives reload, follows Undo, and replaces older thinking without replaying raw provider records.

Implementation code and deterministic tests for full retained-history composition, provider-specific prompt-cache request controls, capacity rejection, and native usage accounting. The request/stream archive path is now wired through `src/integration/generation-runner.ts` and the serialized controller archive method.

## Method

- Compose retained `HistoryCheckpointV1` messages in archive order. Keep each message ID, source role, segment, provider/model attribution and exact text in a JSON data record. Map historical non-assistant roles to user messages so old system/developer content cannot become current instructions. Exclude messages marked discarded.
- Append a fresh current-input record containing FEN, piece/color/side state and a sampled clock snapshot. Only retained records are included in the stable-history prefix.
- Encode the composed history with the existing pure Chat Completions, Responses and Anthropic Messages request encoders. Apply OpenAI cache affinity/retention, OpenRouter Chat session affinity, or Anthropic ephemeral controls only when explicitly supplied for the selected route/model. These controls do not assert a provider cache hit.
- Measure UTF-8 bytes from the exact encoded destination body. When a context limit is supplied, require a destination-specific token counter and reserve configured output and reasoning headroom. Reject known overflow or unverifiable capacity without modifying the history.
- Preserve each provider's raw usage object and rate card. Normalize Chat/Responses cached input as included in total input and Anthropic cache read/write categories separately. Reasoning tokens remain part of native output totals. Keep rate estimates distinct from explicitly supplied measured charge records; absent usage/rates remain unknown.

## Deterministic evidence

- `src/history-cost/history.test.ts`: nine ordered source/destination protocol combinations, attribution and escaping, discarded-line exclusion, fresh clock suffix, stable prefix, provider-specific cache body controls, and byte/token capacity rejection.
- `src/history-cost/usage.test.ts`: Chat Completions, Responses and Anthropic usage fixtures; cache category reconciliation; reasoning inclusion; raw unknown-field retention; estimate/measured separation; unknown usage/rates and currency separation.
- `src/integration/controller-history.integration.test.ts`: local two-request Responses fixture plus an earlier failed request; asserts persisted raw request/response journal and usage, database close/reopen, first-turn user input/answer/reasoning/plan replay in the next request body, and credential-echo quarantine/export blocking.
- `src/integration/generation-runner.test.ts`: runner persistence seam and stale Stop response behavior.
- Shared runner/controller contract: [KHA-37 API](KHA-37-api.md). The return persistence field now reports local save/quarantine state, not a placeholder.
- `pnpm run typecheck`: passed.
- `pnpm run lint`: passed.
- `pnpm run test`: 27 files, 353 tests passed.
- `pnpm run build`: passed.

## Limits

These are synthetic fixtures. No native provider request, actual cache hit, provider charge, or live handoff was run. The current runner is a single move-turn API; diagnostics/correction/retry callers need to supply request purpose and their own accounting inputs before those categories can be reported. Rates and measured charges remain absent by default, so their cost is unknown. Token capacity is only verified when the caller supplies the selected destination's tokenizer. Raw late bytes arriving after Stop are rejected by the request fence and are not archived as late evidence. Queued model handoffs now use the [controller handoff API](KHA-38-controller-api.md). The Chromium suite checks full discarded conversation retention after Undo. Cache request controls exist in the protocol API; the current play UI does not expose cache configuration. Product acceptance cases remain `not_run` in `docs/spec/mvp-acceptance.json`.
