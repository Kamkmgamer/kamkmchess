# Proof search Worker smoke check

From the repository root, install the pinned dependencies and start Vite:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev --port 5176 --strictPort
```

Open `http://127.0.0.1:5176` in a browser. Run this expression in its developer console or the collaborative browser's page evaluation tool:

```js
await (await import('/experiments/proof-search-worker/smoke.js')).runProofSearchSmoke()
```

Expected: `passed: true`, partial `state-budget`, durable checkpoint `found`, resumed `dead` with four states and four edges, and `cancelled`. Failures reject with an error. The helper starts the actual module Worker, saves a partial checkpoint through native IndexedDB, closes and reopens the database, resumes the saved query in the Worker, and cancels a larger query. It uses a disposable database and terminates its Worker on completion. No AI credentials or hosted services are required.

This exercises Vite development Worker loading. It does not test deployed bundle/CSP configuration, browser crash durability, the required native browser/device matrix, or product integration. The placeholder app does not invoke the search Worker.
