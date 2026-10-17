# Pending adjudication browser check

From the repository root, run `pnpm dev --port 5182 --strictPort`. Open
`http://127.0.0.1:5182/` and evaluate this expression in the browser console:

```js
import('/experiments/adjudication-controller/smoke.js').then(m => m.runAdjudicationSmoke())
```

The helper uses the actual controller, analysis runner, module Worker and native
IndexedDB. It creates an unknown setup with unstarted clocks, runs a one-state
pass, closes and reopens both databases, then explicitly resumes analysis to check
the researched four-state dead-position certificate. It asserts that the final
draw retains the original position-entry event and time and is saved durably.
It terminates its Workers and deletes its disposable databases on completion.

This checks Vite development loading and one local storage reopen. It does not
certify deployed bundles/CSP, crash durability, other browsers, devices or assistive
technology. The application page is still a placeholder. No provider, hosted
account, credentials or paid requests are used.
