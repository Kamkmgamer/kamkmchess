// Package subject derives the one-way reference of a removed subject.
//
// A removal never retains the identifier of the subject it removed. The
// removal tables, the deletion marker, the removal ledger and the encrypted
// backup bundle carry the reference instead, and a restore finds the rows of
// the subject by that reference.
//
// The reference is one way: the derivation cannot be inverted, and the domain
// separation keeps the value from being compared with a hash of the same
// identifier in another context.
//
// The derivation is mirrored in SQL, so the database can find the rows of a
// subject without the service ever sending the identifier to it.
package subject

import (
	"crypto/sha256"
	"encoding/hex"
)

// Domain separates the reference of a subject from every other use of a hash
// of that subject.
const Domain = "kamkm.online.removal.v1:"

// Reference returns the one-way reference of a subject identifier.
func Reference(identifier string) string {
	sum := sha256.Sum256([]byte(Domain + identifier))
	return hex.EncodeToString(sum[:])
}

// SQLReference is the SQL expression that derives the one-way reference of an
// owner column.
//
// The expression matches the derivation of Reference exactly, so a removal
// finds the rows of its subject by the reference alone.
func SQLReference(column string) string {
	return `encode(sha256(convert_to('` + Domain + `' || ` + column + `, 'UTF8')), 'hex')`
}

// AccountRemovedSQL reports whether an account was removed.
//
// The account deletions are the record of an ordinary account deletion, and
// the removal requests are the record of an explicit removal. A removal
// request means the participant is gone, whatever its scope: both scopes
// remove the account, and the explicit removal erases the shared replays as
// well.
//
// The removal of the public replay of one match is not a removal request. It
// keeps the participant, so it never closes a seat anywhere.
//
// The argument is the reference of the account. The removal tables store the
// reference directly, so the comparison is direct and never hashes the stored
// value a second time.
var AccountRemovedSQL = `SELECT EXISTS(
  SELECT 1 FROM online_account_deletions WHERE account_id = $1
  UNION ALL
  SELECT 1 FROM online_removal_requests WHERE subject_kind='account' AND subject_id = $1)`

// GuestRemovedSQL reports whether a guest was removed.
//
// The argument is the reference of the guest, never the guest identifier.
var GuestRemovedSQL = `SELECT EXISTS(
  SELECT 1 FROM online_removal_requests WHERE subject_kind='guest' AND subject_id = $1)`
