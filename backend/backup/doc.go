// Package backup creates, verifies, rotates and restores encrypted logical
// exports of the owner-only PostgreSQL storage schema.
//
// Authority limits
//
//   - This package is an operator tool. It never serves requests, never
//     receives an owner identity and never decides chess legality or results.
//   - Secrets are never read from files or written to logs. Callers inject an
//     environment variable name; this package only ever sees the value it is
//     given and never retains it beyond the call.
//   - Rotation never deletes a file on its own. It returns an explicit plan and
//     the caller decides whether to apply it, so no silent retention purge is
//     possible.
//   - Restore validates the authenticated plaintext before any database write.
//     Tombstones from the bundle are reapplied after the logical restore so a
//     deleted game never resurrects, including when an older rotation copy is
//     restored.
//
// The container format is a plain header plus an AES-256-GCM ciphertext over a
// pg_dump plain-text logical export. Everything is deterministic and offline
// testable: the dump and restore processes and the tombstone tables are
// interfaces, so no test needs a database, a network or a credential.
package backup
