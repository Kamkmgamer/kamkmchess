// Package onlinekeys holds the shared low-level key protocols of the online
// service.
//
// It is a leaf package on purpose. The online writer, the authorization
// service and the privacy service all depend on it, so the shared protocols
// live in one place and none of those packages has to depend on another.
//
// The protocols are:
//
//   - the advisory lock keys of the account scope and of the guest seat
//     scope, which order a command against a revocation, a link or a
//     removal of the same participant;
//   - the one-way reference of a removed subject, which lets the removal
//     ledger and the deletion markers name a subject without retaining its
//     identifier.
package onlinekeys

import (
	"crypto/sha256"
	"encoding/hex"
	"hash/fnv"
)

// The lock scopes of the online service.
const (
	// LockAccount is the scope of an account participant.
	LockAccount = "account"
	// LockSeat is the scope of one guest seat.
	LockSeat = "guest-seat"
)

// AdvisoryKey derives a stable 64-bit advisory lock key.
//
// The key is derived from the parts, so two callers that name the same
// scope take the same lock.
func AdvisoryKey(parts ...string) int64 {
	hash := fnv.New64a()
	for _, part := range parts {
		_, _ = hash.Write([]byte(part))
		_, _ = hash.Write([]byte{0})
	}
	return int64(hash.Sum64() & 0x7fffffffffffffff)
}

// AccountLockKey is the advisory lock key of one account scope.
//
// The subject is the raw subject of the participant, so the online writer,
// the authorization service and the privacy service order their work
// against each other.
func AccountLockKey(subject string) int64 {
	return AdvisoryKey(LockAccount, subject)
}

// SeatLockKey is the advisory lock key of one guest seat.
func SeatLockKey(matchID string, seat string) int64 {
	return AdvisoryKey(LockSeat, matchID, seat)
}

// SubjectReference is the one-way reference of a subject.
//
// The reference lets the removal ledger and the deletion markers name a
// subject without retaining its identifier. It is derived with a domain
// separation, so it cannot be compared with a hash of the same value in
// another context.
func SubjectReference(subjectID string) string {
	sum := sha256.Sum256([]byte("kamkm.online.removal.v1:" + subjectID))
	return hex.EncodeToString(sum[:])
}
