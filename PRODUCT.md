# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Inferred from the existing product and request: people who want to play chess
against AI agents, queue for a casual online match, or start a private game
with a friend. They may be signed out guests or signed-in account holders.

## Product Purpose

Kamkm chess lets a person play chess against AI models and other people in the
browser. Success means a first-time player can choose one clear way to play,
configure only what that path needs, and reach the active game without losing
the context of what is happening.

## Positioning

The product treats AI models as player agents that choose their own moves,
while keeping ordinary chess controls and online matches in one workspace.

## Operating Context

The online flow includes casual matchmaking, friend invitations with shareable
codes or links, optional player-agent seats, live clocks, and game history.
Provider credentials stay in the browser's connection store; the online
service owns match coordination, not private AI credentials.

## Capabilities and Constraints

The existing web app supports local games, online queue entries, friend games,
agent seats, invitation previews, live match boards, profile history, and
guest play. Queue matchmaking requires an account; friend play can work as a
guest. Preserve the current service contracts, accessible controls, and board
behavior while simplifying the entry flow.

## Product Principles

- Let the player choose a single intent before showing setup details.
- Keep waiting, active play, and history visibly distinct destinations.
- Explain what happens next after every commitment.
- Make AI setup explicit and safe; never imply an agent is ready without a
  connected model.

## Accessibility & Inclusion

Keep keyboard navigation, visible focus, semantic regions, status announcements,
reduced-motion behavior, and responsive layouts for narrow screens.
