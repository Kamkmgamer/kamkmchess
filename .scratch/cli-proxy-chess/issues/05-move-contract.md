# Define legal move selection and model failure behavior

Publication: Draft for Linear
Label: wayfinder:grilling
Mode: HITL
Blocked by: [Document CLIProxyAPI model discovery and move requests](02-proxy-api.md)

## Question

What information and guidance may a model use to choose its own move, and what happens when it fails to produce a usable legal move?

Decide position and history representation, move notation, any supplied legal-move list, output validation, promotion handling, bounded retry behavior, refusals, timeouts, disconnects, cancellation, and exhaustion of retries. Preserve the agreed rule that the model chooses the move. Define who owns the authoritative position and how a stale or duplicate response is prevented from changing the game twice. Specify observable outcomes and later live checks without inventing model success rates.

