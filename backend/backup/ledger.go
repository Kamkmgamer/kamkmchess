package backup

import (
	"fmt"
	"sort"
	"time"
)

// Tombstone is the durable deletion record for one game. It is payload free by
// design: the live checkpoint, archive chunks and events are removed at delete
// time and only this identifier, owner, deletion time and last accepted
// revision/epoch survive.
type Tombstone struct {
	GameID       string    `json:"gameId"`
	OwnerID      string    `json:"ownerId"`
	DeletedAt    time.Time `json:"deletedAt"`
	LastRevision int64     `json:"lastRevision"`
	LastEpoch    int64     `json:"lastEpoch"`
}

func (t Tombstone) validate() error {
	if t.GameID == "" || t.OwnerID == "" || t.DeletedAt.IsZero() {
		return fmt.Errorf("%w: incomplete tombstone for game %q", ErrLedgerConflict, t.GameID)
	}
	if t.LastRevision < 1 || t.LastEpoch < 1 {
		return fmt.Errorf("%w: implausible revision/epoch for game %q", ErrLedgerConflict, t.GameID)
	}
	return nil
}

// MergeLedgers unions two deletion ledgers, keeping the later deletion for
// each game. Restoring an older rotation copy and reapplying every newer
// tombstone is what keeps a deleted game from resurrecting.
func MergeLedgers(older, newer []Tombstone) ([]Tombstone, error) {
	byGame := map[string]Tombstone{}
	for _, set := range [][]Tombstone{older, newer} {
		for _, entry := range set {
			if err := entry.validate(); err != nil {
				return nil, err
			}
			current, exists := byGame[entry.GameID]
			if !exists {
				byGame[entry.GameID] = entry
				continue
			}
			if current.OwnerID != entry.OwnerID {
				return nil, fmt.Errorf("%w: game %q has two owners", ErrLedgerConflict, entry.GameID)
			}
			byGame[entry.GameID] = laterTombstone(current, entry)
		}
	}
	merged := make([]Tombstone, 0, len(byGame))
	for _, entry := range byGame {
		merged = append(merged, entry)
	}
	sort.Slice(merged, func(i, j int) bool { return merged[i].GameID < merged[j].GameID })
	return merged, nil
}

// laterTombstone breaks a timestamp tie with the higher ownership epoch, which
// is the value the delete path actually advanced.
func laterTombstone(a, b Tombstone) Tombstone {
	switch {
	case a.DeletedAt.After(b.DeletedAt):
		return a
	case b.DeletedAt.After(a.DeletedAt):
		return b
	case a.LastEpoch != b.LastEpoch:
		if a.LastEpoch > b.LastEpoch {
			return a
		}
		return b
	default:
		if a.LastRevision > b.LastRevision {
			return a
		}
		return b
	}
}

// RecoveryKind describes what a restore must do to keep a deletion intact.
type RecoveryKind string

const (
	// RecoveryApply inserts a tombstone that the restored database lost and
	// removes any live rows the older export still contains.
	RecoveryApply RecoveryKind = "apply-tombstone"
	// RecoveryRefresh updates a tombstone whose live deletion time is older
	// than the ledger, which happens when an older rotation copy is restored.
	RecoveryRefresh RecoveryKind = "refresh-tombstone"
	// RecoveryKeep needs no write.
	RecoveryKeep RecoveryKind = "keep"
)

// RecoveryAction is one reviewed deletion-recovery decision.
type RecoveryAction struct {
	GameID       string       `json:"gameId"`
	Kind         RecoveryKind `json:"kind"`
	LiveDeleted  time.Time    `json:"liveDeletedAt,omitempty"`
	LedgerDelete time.Time    `json:"ledgerDeletedAt"`
}

// PlanDeletionRecovery compares the tombstones present after a logical restore
// with the ledger carried by the bundle and the operator-supplied newer
// ledgers. It returns a deterministic plan; nothing is written here.
func PlanDeletionRecovery(live, ledger []Tombstone) ([]RecoveryAction, error) {
	merged, err := MergeLedgers(ledger, live)
	if err != nil {
		return nil, err
	}
	liveByGame := map[string]Tombstone{}
	for _, entry := range live {
		if err := entry.validate(); err != nil {
			return nil, err
		}
		if existing, exists := liveByGame[entry.GameID]; exists {
			liveByGame[entry.GameID] = laterTombstone(existing, entry)
		} else {
			liveByGame[entry.GameID] = entry
		}
	}
	actions := make([]RecoveryAction, 0, len(merged))
	for _, entry := range merged {
		existing, present := liveByGame[entry.GameID]
		kind := RecoveryKeep
		if !present {
			kind = RecoveryApply
		} else if existing.DeletedAt.Before(entry.DeletedAt) || existing.LastEpoch < entry.LastEpoch {
			kind = RecoveryRefresh
		}
		action := RecoveryAction{GameID: entry.GameID, Kind: kind, LedgerDelete: entry.DeletedAt}
		if present {
			action.LiveDeleted = existing.DeletedAt
		}
		actions = append(actions, action)
	}
	return actions, nil
}

// SummarizeRecovery counts each action kind for an operator report.
func SummarizeRecovery(actions []RecoveryAction) map[RecoveryKind]int {
	counts := map[RecoveryKind]int{RecoveryApply: 0, RecoveryRefresh: 0, RecoveryKeep: 0}
	for _, action := range actions {
		counts[action.Kind]++
	}
	return counts
}
