# Fixture entry points

Run `npm test` once or `npm run test:watch` while developing. Vitest runs Node-based offline fixtures in `src/**/*.test.ts`, `src/**/*.test.tsx` and `tests/**/*.test.ts`. Experiments and the disposable prototype are excluded. Run one file with `npm test -- path/to/file.test.ts`.

The suite includes product fixtures for strict rules, pure clock calculations, independent proof checks, atomic checkpoints and game archives. `npm test` fails when no matching fixtures exist. Run one file with `npm test -- src/rules/rules.test.ts`, `npm test -- src/clocks/index.test.ts`, `npm test -- src/proofs/checker.test.ts`, `npm test -- src/storage/storage.test.ts` or `npm test -- src/archive/archive.test.ts`. Deterministic coverage remains separate from product acceptance.

The approved [module handoff](../docs/spec/mvp-handoff.md#implementation-sequence-and-module-handoff) and [module guide](../docs/architecture/modules.md#verification-seams) identify the controller, strict rules, clock/checkpoint, archive/replay, protocol and proof-checker seams. Use TDD for behavior at those interfaces. Write one failing test, implement that behavior, and rerun its file and typechecking before the next slice. Run the full suite once before completing a ticket.

Use independent expected positions, counters, deadlines and wire records. Preserve an acceptance ID in fixture descriptions when applicable. Cover aborts, invalid inputs and stale identities at the relevant seam. Never replace native/AT/live evidence with these deterministic fixtures. No test needs a real provider key, account or paid request.
