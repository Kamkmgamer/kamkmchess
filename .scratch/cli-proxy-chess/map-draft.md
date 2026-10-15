# Find the way to the CLIProxyAPI chess MVP

Publication: Published as [Find the way to the CLIProxyAPI chess MVP](https://linear.app/kamkm/issue/KHA-5/find-the-way-to-the-cliproxyapi-chess-mvp). The text below is the archived publication draft. Continue work in Linear.
Label: wayfinder:map

## Destination

Reach a build-ready MVP specification for a public website where casual chess players connect their own CLIProxyAPI instance, choose an available model, and play chess against it. The model chooses its own moves. The specification must settle the behavior, connection requirements, architecture, and acceptance criteria needed for implementation.

## Notes

- This is a planning effort. Implementation begins after the specification is settled.
- The audience is casual chess players curious about AI who already have CLIProxyAPI set up.
- Each player connects their own proxy and uses the subscriptions connected to it. The earlier proposal for separate provider API keys is superseded.
- Model availability starts with what the connected CLIProxyAPI exposes. Supporting a fixed GPT, Gemini, and Claude trio is not a launch requirement.
- The product is a public website. A local-only app is not the agreed destination.
- The MVP focuses on a chess match, model selection, and clear connection and turn status.
- Models choose moves. The role of rule validation and legal-move guidance is an open decision.
- Linear is the canonical tracker. The map is a parent issue labelled `wayfinder:map`; its tickets are child issues with native blocking relationships.
- Every session should consult wayfinder, domain-modeling, and unslop. Use grilling for human decisions, research subagents for external facts, and prototype plus impeccable for the interface ticket.
- The project glossary is `CONTEXT.md`. Keep decision detail in resolution comments on the individual tickets.
- Do not invent evidence of model playing strength or compatibility. Research should distinguish source-backed facts from behavior that still needs live validation.
- Future sessions should take the first open, unblocked, unassigned child in creation order and assign it to the developer driving the effort before working.

## Decisions so far

<!-- Empty at charting. Agreed scope is recorded in Notes; ticket resolutions will be indexed here. -->

## Not yet specified

A viable browser-to-proxy route may introduce a local companion, a relay, certificate setup, or browser permission flows. The resulting installation, distribution, and maintenance questions cannot be specified until the connectivity research shows which route is workable.

## Out of scope

- Building or deploying the platform during this planning effort.
- Chat with the model opponent.
- A chess engine choosing moves on the model's behalf.
- Platform-funded model usage, billing, and selling model access.
- Human-versus-human and model-versus-model game modes.

