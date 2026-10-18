# KHA-42 browser account integration boundary

`src/accounts/` now provides an optional Clerk JS browser adapter, an account identity subscription, scoped credential cleanup, an explicit guest-import preview/copy API, and an IndexedDB-backed account game repository. The Clerk package is loaded only when a publishable key is present. The implementation uses the official package `@clerk/clerk-js@6.39.1`; the parent integration added it as an exact runtime dependency.

The current allowlisted public config shape is:

```ts
{
  clerk: {
    publishableKey: 'pk_…',
    afterSignInUrl: 'https://app.example/return'
  }
}
```

No key means the account session stays disabled and guest play remains available. Never put a Clerk secret key or API credential in this config. `createAccountSession` accepts the official loader by default and still accepts an injected loader for deterministic tests. Its identity token closure is fenced to the exact Clerk user, stable session ID, and identity generation that created it. Same-session token refresh keeps the identity valid. `AccountSession.dispose()` removes listeners and invalidates captured token closures.

`createIndexedDbAccountData` reads full guest records from the guest database, then imports a validated archive into a physically separate per-account game database. It changes only `checkpoint.namespace`; IDs, epochs, clocks, rule/history/archive/practice data and received event/chunk bytes remain intact. A target collision fails through the existing `GameStore.importGameArchive` transaction. Deletion validates account ownership before deleting game/outbox rows and recording its tombstone. It never reads or copies the connection credential store. Account connection namespaces preserve exact case-sensitive Clerk user IDs.

`src/main.tsx` dynamically mounts `AccountWorkspace` only when all three allowlisted public build settings enable accounts. The wrapper mounts `AccountPanel`, selected guest import, an account game list, separate account compositions, manual sync and explicit takeover. `MatchComposition.registryScope` includes the physical database so a preserved local continuation and accepted cloud continuation cannot share a writer. The React app key also includes that scope so takeover opens the new controller.

`MatchComposition.dispose()` aborts and fences generation, closes analysis sessions and owned game storage, and releases its exact controller registry entries. The wrapper evicts compositions on identity loss, return to guest play and physical database replacement. A retiring database must finish disposal before another composition can open it. The shared connection store and guest database stay available.

Sign-out fences pending work, attempts to clear credentials under exactly the departing Clerk account namespace, clears in-memory identity, hides private views, and completes Clerk sign-out even if local key deletion fails. Report that deletion failure to the caller; do not restore the departed private view. `openSignIn` displays the configured Clerk sign-in UI, so Google must be enabled in the Clerk project. Callback origins and Google provider provisioning are deployment checks, not verified by these browser fixtures.

## Evidence and remaining integration

Focused fake IndexedDB tests cover same-ID account copy into separate storage, preservation of complete records and guest source, deletion ownership, cloud adoption and tombstones. Unit fixtures cover unconfigured guest behavior, identity-scoped sign-out, callback origin rejection, same-session refresh and selected guest import. The optional wrapper is implemented but Clerk is not provisioned, and no real callback, deployed account, or native-device check has run. Exact deployed Clerk CSP origins, Google sign-in, the Go API and managed storage remain external prerequisites. Accounts stay disabled by default.
