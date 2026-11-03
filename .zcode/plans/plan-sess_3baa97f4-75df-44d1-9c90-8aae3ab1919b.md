# Multi-premove queue (chess.com-style)

## Context

Today the play screen queues exactly **one** premove because the queue slot lives inside Chessground (`premovable.current` is a single `[orig, dest]` tuple). `ChessBoard.tsx` mirrors that tuple into React only for display. The goal: let the user queue **unlimited premoves** while the AI thinks, play them one per AI reply, validate each at execution time, and drop a premove **and everything after it** the moment one becomes illegal — matching chess.com's documented behavior (queue → instant play per reply → cancel-all on illegal; promotion piece chosen at queue time; right-click cancels).

Premove stays scoped to the classic workspace (`premoveColor` gating in `App.tsx:1112-1116`); the online workspace keeps premoves disabled (`online-workspace.tsx:2019-2028`).

## Design

ChessBoard owns a React-side queue; Chessground's single slot is kept pointed at the **queue head** (its native `current-premove` highlight + `playPremove` validation keep working), and tail entries are highlighted via Chessground's `highlight.custom` square classes using the existing `current-premove` CSS class (`render.ts:249-250` supports this).

**Semantics (chess.com parity):**
- Queue any number of premoves while the AI thinks (input path unchanged — Chessground's `premovable.events.set` fires per queued move; append instead of overwrite).
- On each AI reply, the head auto-plays if legal (`instance.playPremove()` already validates against fresh `movable.dests`); remaining entries wait for the next reply.
- If the head is illegal when its turn arrives → **clear the entire queue** (silently, as today).
- Promotion premoves: opening the queue of a pawn move to the back rank opens the existing-style promotion picker **at queue time**; the chosen piece is stored with the queued entry.
- Escape / right-click / Cancel button / history review / new game / game end → clear the whole queue.

## Changes

### 1. `src/ui/ChessBoard.tsx` (main work)

- Replace the single `premove` state (line 61) with:
  - `type QueuedPremove = { from: Key; to: Key; promotion?: Promotion }`
  - `premoves` state + `premovesRef` (ref needed inside Chessground callbacks), plus `pendingPremovePromotion` state for the queue-time picker.
- `syncPremoveDisplay(instance)`: one function that points `premovable.current` at the head tuple (or `undefined` when the queue is empty or a promotion pick is pending) and sets `highlight.custom` to a `Map` marking every tail entry's from/to squares with `'current-premove'`. Called from the `set`/`unset` events and after every queue mutation.
  - The `unset` event must **re-sync** (not clear the queue): Chessground unsets its slot on drag-start (`drag.ts:80`) and mid-cancel; the React queue survives and the slot is re-pointed to the head.
- `premovable.events.set(orig, dest)`: if the piece on `orig` is a `premoveColor` pawn and `dest` is its back rank → open `pendingPremovePromotion` (don't append yet); otherwise append `{from, to}`. Then sync.
- **Queue-time promotion picker** rendered inside ChessBoard, reusing App's markup/CSS classes (`promotion-panel`, `promotion-options`, `button quiet`) with `PROMOTIONS` from `src/ui/promotion-options.ts` and `pieceImage(premoveColor, value, pieceStyle)` from `src/ui/piece-image.ts`. Pick → append entry with `promotion`; cancel → drop the pending move.
- **Execution** (effect at lines 176-196): when `!disabled` and the queue is non-empty, call `instance.playPremove()`; `true` → pop the head and sync; `false` → clear the whole queue.
- **`movable.events.after`** (lines 84-104): accept the third `metadata` arg; when `metadata.premove`, enrich the submitted move with the head entry's `promotion` (read from `premovesRef` **before** the pop) and on rejection/catch also clear the whole queue.
- Widen the `onMove` prop to `(move: CoordinateMove) => Promise<boolean>` (App's `attemptBoardMove` already accepts this — `PromotionMove` is a supertype).
- Cancel paths (Escape effect 164-171, `onContextMenu` 201, Cancel button 204, identity/`premoveColor` effect 159-162) → clear queue + pending promotion.
- Notice UI (202-206): single entry keeps the exact current string `Premove ${from} to ${to} queued.` (existing tests depend on it); multiple entries → `Premoves queued: e2 e4, g1 f3.` plus a small visible list of the queued moves and the Cancel button.
- Cleanup hardening: set `board.current = null` **before** `instance.destroy()` so destroy-time `unset` events can't re-enter a destroyed board.

### 2. `src/ui/App.tsx` (one-line)

- `attemptBoardMove` (line 843): open the picker only when `hasPromotions && !move.promotion`, so a premove submission carrying its promotion submits directly.

### 3. `tests/e2e/play.spec.ts`

The 3 existing premove tests keep passing unchanged (single-entry strings/highlight counts preserved). Add:
- **Chain**: hold the AI, queue `g1f3` + `f1c4` → status shows both, 4 `current-premove` squares; AI replies `e7e5` → `Nf3` plays; second held AI reply (`b8c6`) → `Bc4` plays; assert move counts/SANs at each step.
- **Drop-all on illegal head**: after 1.e4 e5, hold the AI's 2nd reply as `d8h4` (Qh4+); queue `g1f3` + `f1c4`; release → check makes `Nf3` illegal → **both** premoves dropped, move count stays 3, no notice, no `current-premove` squares.
- **Promotion premove**: script `e4/e5, a4/a6, a5/b5, axb6/Nc6, bxa7/d6`, then while the AI thinks queue `a7a8` → picker appears at queue time → pick Queen → queued as `a7a8q`; release held reply → `a8=Q` plays. Also cover picker-cancel queues nothing.

### 4. `README.md` (line 13)

Update the "queue one premove" sentence to describe the queue: multiple premoves, one per reply, whole queue clears when a premove becomes illegal or via Escape/right-click/Cancel.

## Known limitation (accepted)

A queued move must start from a square that currently holds one of your pieces (Chessground's grab-time rule, `premove.ts:34`). Opening-chain style queues (e.g. `Nf3`, `Bc4`, …) and captures work; same-piece multi-hop sweeps from not-yet-occupied squares can't be expressed — matching Chessground's input model.

## Verification

1. `pnpm lint && pnpm typecheck` — clean (repo gate is `--max-warnings 0`).
2. `pnpm test` — unit suites untouched and green.
3. `pnpm exec playwright test tests/e2e/play.spec.ts` — all premove E2E cases including the 3 new ones.
4. Full gate `pnpm check` (lint + test + build) before finishing.