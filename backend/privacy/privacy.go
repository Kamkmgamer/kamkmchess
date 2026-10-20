// Package privacy removes the data of an account or of a guest from the
// shared online service.
//
// Two flows exist, and they are deliberately separate.
//
// An ordinary account deletion removes the profile, the identifying snapshots
// and the service-held private owner data of the account. The shared games
// stay, and the deleted participant appears as "Deleted player".
//
// An explicit verified removal erases the shared replays from both online
// histories and from the public URLs. Only the anonymous result aggregates of
// the opponent remain.
//
// Both flows are idempotent. A repeated request answers with the same result,
// never counts a result twice, and never removes a game that was already
// removed.
//
// Every removal is recorded in a durable removal ledger. The ledger is what a
// restore of an older backup replays before the restored database serves
// traffic, so an erased game or a removed identity cannot come back.
package privacy

import (
	"errors"
	"time"
)

// SchemaVersion is the version of the privacy answer wire contract.
const SchemaVersion = 1

// The scopes of a removal.
const (
	// ScopeAccountDeletion anonymizes the shared games and keeps them.
	ScopeAccountDeletion = "account_deletion"
	// ScopeExplicitRemoval erases the shared replays from both histories.
	ScopeExplicitRemoval = "explicit_removal"
)

// The operating targets of the specification.
//
// The live service data and the public projections are removed within
// twenty-four hours of the verification of the request. The recovery copies
// are sanitized within thirty days.
const (
	// DefaultLiveRemovalDelay is the live removal target.
	DefaultLiveRemovalDelay = 24 * time.Hour
	// DefaultRecoverySanitizeDelay is the recovery copy target.
	DefaultRecoverySanitizeDelay = 30 * 24 * time.Hour
)

// Errors reported by the privacy service.
var (
	// ErrNotAuthorized reports a caller that does not own the subject it
	// tried to remove.
	ErrNotAuthorized = errors.New("privacy: not authorized")
	// ErrNotFound reports a removal request that does not exist.
	ErrNotFound = errors.New("privacy: not found")
	// ErrInvalidArgument reports a refused argument.
	ErrInvalidArgument = errors.New("privacy: invalid argument")
	// ErrLedgerNotApplied reports a removal ledger that was not replayed in
	// the database.
	//
	// The service must not serve traffic in that state: a restored database
	// that still holds the rows of a removed game would publish it again.
	ErrLedgerNotApplied = errors.New("privacy: the removal ledger was not applied")
)

// Report is the answer of a removal flow.
//
// It states what was removed, what was anonymized, and when the live data and
// the recovery copies are due to be gone.
type Report struct {
	SchemaVersion int    `json:"schemaVersion"`
	RemovalID     string `json:"removalId"`
	Scope         string `json:"scope"`
	Status        string `json:"status"`
	// AnonymizedMatches counts the shared games that were kept as
	// anonymized games.
	AnonymizedMatches int `json:"anonymizedMatches"`
	// RemovedMatches counts the shared games whose replay was erased.
	RemovedMatches int `json:"removedMatches"`
	// VerifiedAt is when the ownership of the request was proven.
	VerifiedAt time.Time `json:"verifiedAt"`
	// LiveDeletedAt is when the live data and the public projections were
	// removed.
	LiveDeletedAt time.Time `json:"liveDeletedAt"`
	// LiveDeleteDueAt is the target of the live removal.
	LiveDeleteDueAt time.Time `json:"liveDeleteDueAt"`
	// RecoverySanitizeDueAt is the target of the recovery copy sanitation.
	RecoverySanitizeDueAt time.Time `json:"recoverySanitizeDueAt"`
}
