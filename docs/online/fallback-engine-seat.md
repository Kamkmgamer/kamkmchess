# The browser engine seat of a queue fallback (F-10)

Owner: the matching worker, for the queue worker (KHA-76) and the parent.

This note assesses the one open question of the queue fallback: **who
authorizes the moves of the browser Stockfish 19 Lite seat**, and it records
the shape that already works against the canonical seams. It invents no new
permission model.

## What the approved specification says

The approved casual-online-chess specification fixes the following:

- the fallback plays the owner's chosen human or agent seat against the
  **browser** Stockfish 19 Lite, with the same time control, random colors
  and the standard starting position;
- the opponent is **identified** as Stockfish;
- the deadline selects the opponent; it is not a guarantee of board rendering
  or of a first move by ten seconds;
- a failed engine preparation never blocks the agent search, and the fallback
  is offered as Retry or Keep searching;
- the rules process is the only authority for legal moves, and every accepted
  move is versioned, fenced and idempotent.

The specification does **not** say that the owner may act for the engine, and
it does not create a second kind of participant. The public replay still
records the declared control per accepted move, so the engine seat has to be
a declared `engine` control with a public label.

## The constraint that decides the shape

The canonical match contract refuses a match whose two seats belong to the
same participant:

```go
// backend/online/contracts.go, CreateMatchSetup.Validate
if s.Seats.White.Participant == s.Seats.Black.Participant {
    return fmt.Errorf("%w: both seats belong to the same participant", ErrInvalidContract)
}
```

That check exists because a seat is an **authorization** identity: the seat
owner is the only actor that may command it, and the accepted fingerprints
and the guest ownership proofs are bound to it. A fallback match therefore
cannot give both seats to the owner.

The second constraint is the guest credential itself: it is bound to exactly
one match and one seat, it is revocable, and it is superseded by a rotation.
It is the only credential the browser already owns for a seat it drives.

## The shape that follows, with no new permission model

The engine seat is a **separate participant** with the declared control
`engine` and the public label `Stockfish 19 Lite`. The owner's browser
receives a **guest seat credential of that one seat** and uses it for the
engine moves. The browser already owns that credential kind for the seats it
drives; nothing new is introduced, and no rule is relaxed.

The properties of that shape:

- the credential authorizes **one seat of one match**. It never authorizes the
  owner's own seat, and it never authorizes another match;
- the engine seat is a guest participant, so the seat owner stays immutable
  and the accepted fingerprints keep their original actor;
- the credential is revocable and its plaintext exists only in the answer
  that delivered it;
- the public projection shows the seat by its public label and its declared
  control, so the replay identifies Stockfish without exposing a credential.

The regression that proves the shape against the real database is
`TestPostgresTheAllocatedEngineSeatTakesOneScopedGuestCredential` in
`backend/integration/online_allocation_test.go`. It creates the fallback
match through the canonical allocation seam, mints the engine seat
credential, and asserts that the credential authorizes the engine seat and
neither the owner's seat nor another match.

## The seams the queue worker uses

| Need | Seam |
| --- | --- |
| create the fallback match | `online.Service.CreateMatchInTx(ctx, tx, cmd)` with `online.NewAllocationCommand(actor, setup, operationID)` |
| validate the standard position | `online.Service.ValidateSetup(ctx, setup)` (outside the transaction) |
| mint the engine seat credential | `onlineauth.Allocator.AcceptInvitationTx(ctx, tx, request)` inside the allocation transaction |
| check a live credential | `onlineauth.Allocator.HasLiveSeatCredential(ctx, q, matchID, seat)` |

The operation identifier of the allocation must be derived from the queue
entry, never from a client supplied key alone. `online.AllocatedMatchID`
mixes the participant into the derivation, so two owners that use the same
client key never name the same match.

## What the queue worker must not do

- It must not let the owner's account session command the engine seat. The
  seat belongs to the engine participant, and the owner commands the engine
  seat with the scoped guest credential.
- It must not relax the "two seats, one participant" check, and it must not
  add a second participant kind.
- It must not store the engine credential in the queue entry. The credential
  is minted for the created match and delivered once, exactly like the guest
  credential of an accepted invitation.

## Status

The shape is implemented and regression tested in the matching worktree. The
queue package, the queue routes and the queue feature gate are owned by the
queue worker (KHA-76). The matching worker does not implement them.
