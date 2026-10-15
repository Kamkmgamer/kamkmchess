# Document CLIProxyAPI model discovery and move requests

Publication: Draft for Linear
Label: wayfinder:research
Mode: AFK
Blocked by: None
Research branch: research/proxy-api
Research asset: research/proxy-api.md

## Question

What source-backed API contract can the MVP rely on to discover a player's available models and request a chess move through CLIProxyAPI?

Inspect the official project documentation and source at an identified release or commit. Establish the relevant discovery and generation endpoints, proxy authentication, model IDs and aliases, request and response shapes, streaming and non-streaming behavior, structured-output or tool support across adapters, useful error and cancellation behavior, and restrictions relevant to subscription-backed accounts. Separate upstream guarantees from provider-specific behavior and from untested assumptions. Explain what can be inferred from discovery and what needs a later live compatibility check. Do not use private credentials or make paid generation calls.

Write one cited findings file on the research branch. Return sufficient evidence for later decisions about the model picker and legal move contract without selecting those product policies yourself.

