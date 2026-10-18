# Compact model input

On 2026-10-18 the owner requested that chess opponents receive only what they need to play, then clarified that they must retain reasoning to continue their plans. This changes the earlier full-transcript replay policy in the MVP handoff and acceptance cases HIS-01, HIS-02, HIS-05 and CST-01. Complete application-received traffic remains archived; move requests carry only chess state and the latest available thinking for the playing side.

Every move request has the current instructions and one JSON input containing:

- Current six-field FEN and side to move. FEN carries pieces, castling rights, en passant and move counters.
- Starting FEN and the committed SAN moves on the current line, so custom starts and game history remain meaningful after reload, Undo, practice or a model switch.
- Remaining milliseconds for both players and increment milliseconds.
- Position identities with occurrence counts greater than one, when present. These warn about imminent repetition draws, including repetitions inherited by practice segments.
- The current turn's rejected coordinate moves and rule explanations, plus a format reminder after a formatting failure. Previous turns' attempts and a previous model's recovery budget do not enter a fresh turn.
- The latest available authored plan and provider-returned reasoning for the playing side, with the source FEN and chosen move when available. Replies are asked for an updated plan of at most 80 words. This replaces the prior thinking record rather than accumulating a transcript. Returned text is preserved; unavailable private reasoning is never invented.

No full prior replies, raw stream events, byte arrays, routing metadata, duplicate piece list, solver results or legal-move suggestions enter this input. Composition reads authoritative rules and turn budgets plus a normalized thinking record. Thinking remains quoted historical data and must be reassessed against the current position. This applies immediately to existing saves without deleting or migrating their archives.

Request size depends on actual moves, relevant repeated positions and one thinking record, not the accumulated provider transcript or request count. The existing encoded-byte limit and optional destination token checks still apply. Cache controls remain provider-specific; the changing position is not declared a stable history prefix.

Thinking is archived in a tagged normalized record using the existing history schema. Only complete answer responses create these records. Older saves can recover plans and normalized reasoning from replies tied to committed moves. Partial, failed or thought-free replies do not erase an earlier usable plan. Undo excludes discarded thinking, practice starts fresh, and model switches can inherit the retained plan for the same chess side.

The archive still preserves exact received bytes, normalized replies, errors, usage, correction messages and discarded continuations. Storage, exports, Undo and credential-echo quarantine retain their existing behavior. Historical specifications and evidence describing full replay should be read with this amendment.
