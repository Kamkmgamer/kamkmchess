# The private agent catalog of the owner

This note publishes the contract of the private model catalog that the account
build hands to the online composition. It is the producer side of the
interface; the composition side is `src/online/composition.ts`.

## What the catalog is

The catalog is read from the browser owned connection store
(`connectionStore` + `namespace`). It holds every saved connection whose
credential is bound and every model that connection currently advertises. A
connection without a bound credential and a model the provider no longer
advertises are not offered.

Nothing in the catalog reaches the service. The provider destination, the
credential and the routing id stay in the browser.

## The three fields of an entry

```ts
interface PrivateAgentEntry {
  readonly id: string;          // the stable private identity
  readonly label: string;       // the unique local display alias
  readonly selection: ModelSelection;  // the private selection
}
```

- `id` is the **stable private identity** of the selection: a local hash of
  the connection id, the configuration revision, the routing id and the
  protocol. It is stable across reloads, it never leaves the browser and it is
  never a public label and never a public routing id.
- `label` is the **unique local display alias** of the model: the name the
  provider advertises, reduced to the character set a shared model label may
  have, with a local ordinal when two private models would otherwise share it
  (`Custom model`, `Custom model 2`). A model whose provider advertises no
  name gets the neutral name.
- `selection` is the private `ModelSelection`. It carries the routing id, so it
  never leaves the browser.

## Why the label is not an identity

Two different private models may carry the same public name. The service
canonicalizes a label it does not know to `Custom model`, so two seats that
play two different private models may both publish `Custom model`. A public
label is therefore never a key:

- the catalog map of the composition is keyed by the **id**;
- the selector of the online screen resolves a choice by the **id** and falls
  back to the unique local alias while the two sides are integrated;
- the seat binding of a match carries the private **selection**, so a seat is
  never played by another model.

## The producer

`src/ui/App.tsx` publishes the catalog:

```ts
online.setAgentCatalog(entries);  // { id, label, selection } of every entry
online.setAgent(chosen ?? null);  // the current agent of the owner
```

The current agent is one of the entries. The owner chooses it in **Your
agents**, which also rebinds the agent seat of the focused online game
(`online.agentDecision(matchId, seat, 'switch-model', choice)`).

## The seat that arrives before the catalog

The catalog fills after the page loaded, so a seat of the owner can be
attached before its selection is known. The producer recovers the binding as
soon as the catalog knows the model: every agent seat of the owner without a
binding is bound to the chosen agent. The recovery never overrides an
existing binding, so a binding the composition made from the selection the
queue entry captured stays authoritative.

## The public label of a seat

The public label of an agent seat is declared to the service through the
existing privacy endpoint (`POST /v1/privacy/account/model-labels`). The
service publishes its own canonical form of it. The private id and the private
selection never reach the service.
