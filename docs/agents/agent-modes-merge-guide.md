# Merge guide: agent modes, remote MCP, boards and the online switch (#43–#50)

This guide is for the maintainer, or the maintainer's coding agent, who merges
the eight pull requests below. It says what each one adds, which ones depend on
each other, the order that merges cleanly, how to resolve every conflict, and
what to do when only some of them are wanted.

Everything new is **off by default**. Merging all eight changes nothing on the
live site until the matching environment variables are set (see
[Turning features on](#turning-features-on)), except the two UI polish PRs and
the navigation fix in #50, which are visible as soon as they deploy.

## The eight pull requests

| PR | Branch (on `rohit3a/kamkmchess`) | What it does | Needs | Stacked on |
| --- | --- | --- | --- | --- |
| [#43](https://github.com/Kamkmgamer/kamkmchess/pull/43) | `polish/landing-sidebars` | Landing sidebar tidy-up; Project opens in a new tab; this guide | — | — |
| [#44](https://github.com/Kamkmgamer/kamkmchess/pull/44) | `polish/new-game-panel` | New game drawer polish; hero no longer cut off by the drawer | — | — |
| [#45](https://github.com/Kamkmgamer/kamkmchess/pull/45) | `feat/agent-seat-webmcp` | Human vs agent, Agent vs engine, Agent vs AI; page tools via WebMCP and `window.kamkmChessAgent` | — | — |
| [#46](https://github.com/Kamkmgamer/kamkmchess/pull/46) | `feat/server-stockfish-seat` | Server-side Stockfish seat for online games; migration 0026 | — | — |
| [#47](https://github.com/Kamkmgamer/kamkmchess/pull/47) | `feat/remote-mcp` | Anonymous remote MCP endpoint `/v1/mcp` | #46 | #46 (commit `36b992b`) |
| [#48](https://github.com/Kamkmgamer/kamkmchess/pull/48) | `feat/agent-setup-page` | "Play with your agent" landing section with copy-ready prompts | #45 (#47 for the remote tabs) | #45 (commit `61d2102`) |
| [#49](https://github.com/Kamkmgamer/kamkmchess/pull/49) | `feat/agent-runner-boards` | Community/Verified agent boards, invite codes, `scripts/agent-runner.mjs`; migration 0027 | #47, #46 | #47 (commits `36b992b`, `85fef85`) |
| [#50](https://github.com/Kamkmgamer/kamkmchess/pull/50) | `feat/online-toggle-profiles` | Mounts the missing game rail (profiles, online play reachable again) and an owner-only online switch; migration 0028 | — | — |

"Stacked on" means the PR branch also contains its parent's commit. GitHub
shows the parent's changes in the child's diff until the parent is merged.
Review only the child's own commits:

| PR | Its own commits |
| --- | --- |
| #47 | `85fef85` Add an anonymous remote MCP endpoint |
| #48 | `b60add4` Add a 'Play with your agent' section |
| #49 | `4e62ca2` Add the agent runner, invite codes and boards; `e49e707` Type the agent runner for the repository's checkJs |

The maintainer can push to every PR branch ("Allow edits by maintainers" is
on), so a rebased branch can be pushed back to the same PR.

## Recommended order

```
#43 → #45 → #44 → #48 → #50 → #46 → #47 → #49
```

Merged in this order, conflicts appear only in the four steps listed below, and
the final tree is byte-for-byte the tree that passed every check in
[Verification done before handing over](#verification-done-before-handing-over).
This is true with **squash merges** and with **merge commits**.

| Step | Conflicts (files) |
| --- | --- |
| #43 | none |
| #45 | none |
| #44 | `src/ui/new-game-setup.css` |
| #48 | none, after rebasing (see below) |
| #50 | none |
| #46 | `.env.example`, `backend/serverapp/server.go`, `docs/architecture/online-operations-contract.md` |
| #47 | `backend/serverapp/server.go`, `tools/onlinefixture/main.go` (after rebasing) |
| #49 | `backend/serverapp/server.go`, `deploy/runtime-grants.policy.json`, `src/landing/App.tsx`, `src/landing/styles.css`, `tools/onlinefixture/main.go` (after rebasing) |

## The reference branch `merge/all-prs`

`rohit3a/kamkmchess` has a branch `merge/all-prs`: current `main` plus all eight
PRs in the recommended order, one commit per PR, with every conflict already
resolved. Each commit's subject starts with the PR number in brackets, for
example `[#46] Add a server-side Stockfish seat`.

Use it two ways:

1. **To resolve a conflict while following the recommended order**, take the
   file from the matching step. The step's commit holds exactly the state of
   `main` after that PR merges:

   ```bash
   git fetch https://github.com/rohit3a/kamkmchess.git merge/all-prs:refs/remotes/rohit/merge-all-prs
   step=$(git log --format=%H --grep='^\[#46\]' refs/remotes/rohit/merge-all-prs -1)
   git checkout "$step" -- backend/serverapp/server.go
   ```

   This is only correct when every earlier PR in the order has been merged.
   When some were skipped, use the rules in [Conflict resolutions](#conflict-resolutions).
2. **To compare the end result.** After all eight are merged,
   `git diff refs/remotes/rohit/merge-all-prs main --stat` should be empty apart
   from anything merged to `main` meanwhile.

Do not merge `merge/all-prs` itself; merge the PRs so each keeps its own
review and history.

## Merging, step by step

### Squash merge (what #37, #40 and #41 used)

A squash merge gives the parent a new commit, so a stacked child still carries
the parent's original commit. Merged as is, the child then conflicts in up to
twelve files. Rebase each stacked child so it carries **only its own commits**
before merging it:

```bash
git fetch origin

# #48, after #45 is squash-merged: drop #45's commit 61d2102
gh pr checkout 48 && git rebase --onto origin/main 61d2102

# #47, after #46 is squash-merged: drop #46's commit 36b992b
gh pr checkout 47 && git rebase --onto origin/main 36b992b

# #49, after #47 is squash-merged: drop the commits of #46 and #47 (up to 85fef85)
gh pr checkout 49 && git rebase --onto origin/main 85fef85
```

`gh pr checkout N` checks out the PR branch with its push target set to the
fork. Resolve any conflicts (next section) with `git add` and
`git rebase --continue`, run the checks for that step, then push the branch
back to the PR and merge it on GitHub:

```bash
git push --force-with-lease   # updates the PR; the maintainer is allowed to push
```
For a PR that is not stacked (#43, #44, #45, #46, #50) and shows a conflict on
GitHub, rebase it on `origin/main` the same way (`git rebase origin/main`) or
merge `origin/main` into it, resolve, and push.

### Merge commits

With merge commits the parent's original commits land on `main`, so stacked
children need no `--onto`. When GitHub reports a conflict, merge `origin/main`
into the PR branch, resolve the same files, and push.

## Conflict resolutions

Every conflict is two PRs adding lines next to each other. **Keep both sides.**
None of them needs a code decision.

| Files | Between | Resolution |
| --- | --- | --- |
| `src/ui/new-game-setup.css` | #44 and #45 | Keep both blocks of rules. |
| `.env.example`, `docs/architecture/online-operations-contract.md` | #50 and #46/#47/#49 | Keep every new variable and every new table row from both sides. |
| `backend/serverapp/server.go`, the `OnlineConfig{…}` literal | #50 and #46/#47/#49 | Keep `OwnerAccounts` (#50) and every `ServerEngine*`, `MCP*` and `AgentBoardsEnabled` field, then run `gofmt -w backend/serverapp/server.go` to realign. |
| `backend/serverapp/server.go`, the `/v1/online/features` handler | #50 and #47/#49 | Use #50's live handler and add the flags from #47 and #49 (example below). |
| `backend/serverapp/server.go`, other spots | #50 and #46/#47/#49 | Keep #50's `switches` store and `whenOpen` queue gate and the other PR's server engine, MCP and boards wiring. |
| `tools/onlinefixture/main.go` | #50 and #47/#49 | Keep both the `ownerAccounts` flag (and its `ONLINE_OWNER_ACCOUNTS` entry) and the `serverEngine` flag. Use #49's flag description when #49 is merged. |
| `deploy/runtime-grants.policy.json` | #50 and #49 | Keep `online_runtime_switches` and `online_agent_games` / `online_agent_invites` in both the grants and the reasons. |
| `src/landing/App.tsx` | #48 and #49 | Import both `AgentConnect` and `AgentBoards`; render `<AgentConnect />` then `<AgentBoards />`. |
| `src/landing/styles.css` | #48 and #49 | Keep #48's agents rules (they end with a `@media (max-width: 900px)` block), then #49's boards rules. Check that every `{` is closed: the agents media query needs its `}` before `.page-sections .boards-section`. |

The `/v1/online/features` handler with #47, #49 and #50 merged:

```go
surface.Handle("/v1/online/features", httpapi.NewLiveFeatures(func(ctx context.Context) httpapi.OnlineFeatures {
	state := switches.State(ctx)
	return httpapi.OnlineFeatures{Friends: state.Friends, Queue: state.Queue, MCP: cfg.Online.MCPEnabled, Boards: cfg.Online.AgentBoardsEnabled}
}))
```

Without #50, keep the static handler and only add `MCP` (#47) and `Boards`
(#49) to it. Without #49, leave out `Boards`.

After resolving Go files, run `gofmt -l backend tools cmd` (prints nothing when
clean) before committing.

## Merging only some of them

| If you skip | Then |
| --- | --- |
| #43 or #44 | Nothing else changes. This guide lives in #43; if #43 is closed, keep the guide by cherry-picking its commit, or just read it from the PR. |
| #45 | Skip #48 too (it is built on #45's agent seat and page tools). |
| #46 | Skip #47 and #49. |
| #47 | Skip #49. #48 still works: its browser-agent prompt uses #45's page tools, and the remote-client tabs stay hidden because `/v1/online/features` never reports `mcp: true`. |
| #48 | #49 then applies without the `App.tsx`/`styles.css` conflicts. |
| #49 | Nothing else changes. Migration 0027 is simply absent. |
| #50 | #46, #47 and #49 then apply without the `server.go`, `.env.example`, operations doc, fixture and grants conflicts. Profiles and online play stay unreachable on desktop (the rail is not mounted on `main`), so this fix is worth taking even without the owner switch. |

The `merge/all-prs` steps assume the full order, so when something is skipped
resolve by the rules above instead of checking files out from it.

Migration numbers have gaps when a PR is skipped (0026 from #46, 0027 from #49,
0028 from #50). That is fine: `cmd/migrate` sorts by version and records which
ones it applied. A skipped PR merged later just applies its migration then.

## Checks for each step

These are the commands CI runs (`.github/workflows/*.yml`). Node 24 and Go 1.26
are needed; `pnpm install --frozen-lockfile` first.

```bash
pnpm check                                   # lint, unit tests, typecheck (app and scripts), build
go vet ./backend/... ./cmd/...
go test -race -count=1 ./backend/... ./cmd/...   # add -timeout 60m; see below for the integration package
go test -tags onlinefixture ./tools/onlinefixture
node deploy/runtime-grants.mjs --check       # every new table has grants
node deploy/runtime-grants-provision.mjs
node --test deploy/*.test.mjs scripts/agent-runner.test.mjs
```

`backend/integration` needs Postgres, the built rules worker and Stockfish:

```bash
pnpm build:rules-worker
KHA41_TEST_DATABASE_URL='postgres://postgres:test@127.0.0.1:55432/kamkm?sslmode=disable' \
KHA66_WORKER_ENTRY="$PWD/build/rules-worker/worker.mjs" \
KAMKM_ENGINE_PATH=/usr/games/stockfish \
go test -p 1 -count=1 -timeout 50m ./backend/integration
```

Without `KAMKM_ENGINE_PATH` (as in CI, which has no Stockfish) the server
engine, MCP and boards integration tests skip; set it to run them. A throwaway
database: `docker run -d --name kamkm-pg-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=kamkm -p 127.0.0.1:55432:5432 postgres:17-alpine`.

To try the new features by hand, `go run -tags onlinefixture ./tools/onlinefixture`
starts a local online stack. Add `--server-engine /usr/games/stockfish` for the
server seat, MCP endpoint and boards, and `--owner-accounts <account>` for the
owner switch.

## Things that are expected and not caused by these PRs

- **Vercel shows "failure" on every PR.** The message is "Authorization required
  to deploy": the PRs come from a fork, so a team member has to authorize the
  preview. `main`'s Vercel builds pass.
- **GitHub Actions show "action required".** First-time contributor workflows
  need a maintainer to click *Approve and run*.
- **`node deploy/verify-fence-access.mjs` fails locally** on `main` too; it
  needs the `kamkmchess-kha67-local` container.
- **Some Playwright specs fail on `main`** after #37/#41. #50 fixes the
  navigation ones. Three signed-in specs in `account-online`/`online-ui` still
  fail for reasons that predate these PRs (for example, the invitation preview
  test shares one browser context between inviter and guest, so the guest owns
  the invitation and Accept is correctly disabled).

## Turning features on

Nothing below is needed to merge. Each flag defaults to off.

| Feature | PR | Settings |
| --- | --- | --- |
| Agent modes in the browser | #45 | none, always available |
| "Play with your agent" section | #48 | none; remote tabs appear once MCP is on |
| Server Stockfish seat | #46 | Build the API image with `--build-arg WITH_SERVER_ENGINE=1`, then `ONLINE_SERVER_ENGINE_ENABLED=1`, `ONLINE_SERVER_ENGINE_PATH=/usr/bin/stockfish`; optional `ONLINE_SERVER_ENGINE_SLOTS` (2), `ONLINE_SERVER_ENGINE_SWEEP_INTERVAL` |
| Remote MCP endpoint | #47 | `ONLINE_MCP_ENABLED=1` (refused unless the server engine is on); behind the proxy `ONLINE_MCP_TRUST_PROXY=1`; optional `ONLINE_MCP_MAX_ACTIVE_GAMES` (50), `ONLINE_MCP_STARTS_PER_HOUR` (20) |
| Agent boards | #49 | `ONLINE_AGENT_BOARDS_ENABLED=1` (needs MCP). Invite codes: `DATABASE_URL=… go run ./cmd/agentinvite --label "…" --uses N` |
| Owner online switch | #50 | `ONLINE_OWNER_ACCOUNTS=<account id>[,…]`; empty means no one sees the switch |

Deploying any of #46, #49 or #50 adds a migration and new grants. On the
server, rebuild `bin/kamkmchess-migrate` and run `python3 provision-runtime.py`
again (it runs the migrations and applies the grants in
`deploy/runtime-grants.policy.json`), then rebuild and restart the API as in
`deploy/README.md`.

Details per feature: `docs/implementation/agent-seat.md`, `server-engine.md`,
`remote-mcp.md` and `agent-boards-runner.md`.

## Rolling back

- Turn the flag off and restart the API. Closing MCP or the boards stops new
  games; games already running finish under the writer as usual.
- The owner switch can close friend play or the queue at runtime from the
  Account panel; it never ends running games.
- Reverting a PR's commit is safe. Its migration tables can stay: nothing reads
  them once the code is gone.

## Verification done before handing over

On 24 October 2026, against `main` at `aa501b5`:

- **Each PR alone** on top of `main`: `pnpm check`, `go vet`, `go test -race`
  (all packages but integration), the fixture build test, the grant checks and
  the deploy/runner Node tests.
- **All eight together** (the `merge/all-prs` tree): all of the above, plus the
  full `backend/integration` suite against real Postgres 17, the rules worker
  and Stockfish 17.1 (passed in 689 s), and every `online-ops` workflow command
  except `verify-fence-access` (fails on `main` too, see above).
- **#50 alone** and **#46 + #47 + #49 without #50**: the full integration suite.
- **Squash replay:** all eight squash-merged in the recommended order, stacked
  children rebased with `--onto` and conflicts resolved as above, give a tree
  identical to `merge/all-prs`.
