# KHA-37 implementation evidence

Implementation code and deterministic tests for full retained-history composition, provider-specific prompt-cache request controls, capacity rejection, and native usage accounting.

## Method

- Compose retained `HistoryCheckpointV1` messages in archive order. Keep each message ID, source role, segment, provider/model attribution and exact text in a JSON data record. Map historical non-assistant roles to user messages so old system/developer content cannot become current instructions. Exclude messages marked discarded.
- Append a fresh current-input record containing FEN, piece/color/side state and a sampled clock snapshot. Only retained records are included in the stable-history prefix.
- Encode the composed history with the existing pure Chat Completions, Responses and Anthropic Messages request encoders. Apply OpenAI cache affinity/retention, OpenRouter Chat session affinity, or Anthropic ephemeral controls only when explicitly supplied for the selected route/model. These controls do not assert a provider cache hit.
- Measure UTF-8 bytes from the exact encoded destination body. When a context limit is supplied, require a destination-specific token counter and reserve configured output and reasoning headroom. Reject known overflow or unverifiable capacity without modifying the history.
- Preserve each provider's raw usage object and rate card. Normalize Chat/Responses cached input as included in total input and Anthropic cache read/write categories separately. Reasoning tokens remain part of native output totals. Keep rate estimates distinct from explicitly supplied measured charge records; absent usage/rates remain unknown.

## Deterministic evidence

- `src/history-cost/history.test.ts`: nine ordered source/destination protocol combinations, attribution and escaping, discarded-line exclusion, fresh clock suffix, stable prefix, provider-specific cache body controls, and byte/token capacity rejection.
- `src/history-cost/usage.test.ts`: Chat Completions, Responses and Anthropic usage fixtures; cache category reconciliation; reasoning inclusion; raw unknown-field retention; estimate/measured separation; unknown usage/rates and currency separation.
- `pnpm run typecheck`: passed.
- `pnpm run lint`: passed.
- `pnpm run test`: 27 files, 353 tests passed.
- `pnpm run build`: passed.

## Limits

These are synthetic fixtures. No native provider request, actual cache hit, provider charge, live handoff or board journey was run. Token capacity is only verified when the caller supplies the selected destination's tokenizer. Product acceptance cases remain `not_run` in `docs/spec/mvp-acceptance.json`.
