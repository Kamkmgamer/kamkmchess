# Validate the connection and chess match interface

Publication: Draft for Linear
Label: wayfinder:prototype
Mode: HITL
Blocked by: [Choose supported proxy setups and credential handling](03-proxy-policy.md), [Choose the model catalog and opponent selection rules](04-model-selection.md), [Define legal move selection and model failure behavior](05-move-contract.md), [Define the MVP match lifecycle](06-match-lifecycle.md)

## Question

What connection, opponent-selection, and match interface lets the intended player start and finish a game with understandable feedback?

Create a disposable interface prototype based on the settled policies and review it with the human. Cover first connection, model selection, board interaction and promotion, connection and model-turn status, recoverable failures, and game end on desktop and mobile. Decide which accessibility and input behaviors the MVP must support. Link the prototype as an asset and record the human's feedback as the resolution. A prototype must not turn into production implementation or contain real proxy credentials.

