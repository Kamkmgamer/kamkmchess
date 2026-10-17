# KHA-39 local board follow-up

The Classic workspace uses the local controller for two-human games. A new game
remains clockless while setup deadness is pending. A checked `not-dead` result
marks setup ready, after which the UI calls `startGame`; unknown or partial
search results keep setup pending and never manufacture a result. During an
in-game pending adjudication, board move input stays disabled while the
controller continues to own clocks and event ordering. The one-second display
tick reconciles only when the snapshot reports a clock expiry or recovery
condition, so ordinary countdown rendering does not write a reconciliation
event every second.

The board offers coordinate moves, pointer/touch moves, and a keyboard-operable
square grid that selects a source and destination. The visual setup editor can
place or remove pieces and choose the side to move; after a visual edit it clears
castling and en-passant rights and resets the move counters. The six-field FEN
field remains available for positions with custom rights, en-passant targets, or
counters. Practice after a model loss is unavailable in this local two-human
screen: this flow has no model opponent or model-loss state to continue from.

History segment provider/model fields remain nullable in the client for guest
two-human games. The Go live validator and the older Supabase migration still
require those fields. This follow-up leaves those server/storage contracts
unchanged, so guest two-human history is not claimed to round-trip through those
server validation paths. The package remains MIT licensed; this work adds no
third-party runtime dependency.
