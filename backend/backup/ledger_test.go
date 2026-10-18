package backup

import (
	"errors"
	"testing"
	"time"
)

func TestMergeLedgersKeepsTheLaterDeletion(t *testing.T) {
	older := []Tombstone{
		tombstone("game-a", day(10), 3, 1),
		tombstone("game-b", day(12), 5, 2),
	}
	newer := []Tombstone{
		tombstone("game-a", day(14), 6, 3),
		tombstone("game-c", day(13), 2, 1),
	}
	merged, err := MergeLedgers(older, newer)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged) != 3 {
		t.Fatalf("merged ledger has %d entries, want 3", len(merged))
	}
	if merged[0].GameID != "game-a" || !merged[0].DeletedAt.Equal(day(14)) || merged[0].LastEpoch != 3 {
		t.Fatalf("game-a did not take the later deletion: %+v", merged[0])
	}
	if merged[1].GameID != "game-b" || merged[2].GameID != "game-c" {
		t.Fatalf("merged ledger is not sorted by game id: %+v", merged)
	}
}

func TestMergeLedgersBreaksTiesWithTheHigherEpoch(t *testing.T) {
	merged, err := MergeLedgers(
		[]Tombstone{tombstone("game-a", day(10), 3, 1)},
		[]Tombstone{tombstone("game-a", day(10), 3, 4)},
	)
	if err != nil {
		t.Fatal(err)
	}
	if merged[0].LastEpoch != 4 {
		t.Fatalf("tie was not broken by the higher epoch: %+v", merged[0])
	}
}

func TestMergeLedgersRejectsContradictoryRecords(t *testing.T) {
	if _, err := MergeLedgers(
		[]Tombstone{tombstone("game-a", day(10), 3, 1)},
		[]Tombstone{{GameID: "game-a", OwnerID: "user_other", DeletedAt: day(11), LastRevision: 4, LastEpoch: 2}},
	); !errors.Is(err, ErrLedgerConflict) {
		t.Fatalf("two owners for one game were accepted: %v", err)
	}
	if _, err := MergeLedgers([]Tombstone{{GameID: "", OwnerID: "user", DeletedAt: day(11), LastRevision: 4, LastEpoch: 2}}, nil); !errors.Is(err, ErrLedgerConflict) {
		t.Fatalf("an incomplete tombstone was accepted: %v", err)
	}
	if _, err := MergeLedgers([]Tombstone{{GameID: "game-a", OwnerID: "user", DeletedAt: day(11), LastRevision: 0, LastEpoch: 0}}, nil); !errors.Is(err, ErrLedgerConflict) {
		t.Fatalf("an implausible revision was accepted: %v", err)
	}
}

func TestPlanDeletionRecoveryAppliesNewerDeletionsToAnOlderRestore(t *testing.T) {
	// The restored database is an older weekly export: it still contains a game
	// that was deleted afterwards, and one deletion it already honours.
	live := []Tombstone{
		tombstone("game-old", day(1), 2, 1),
		tombstone("game-kept", day(2), 3, 1),
	}
	ledger := []Tombstone{
		tombstone("game-kept", day(2), 3, 1),
		tombstone("game-deleted-later", day(9), 7, 2),
	}
	actions, err := PlanDeletionRecovery(live, ledger)
	if err != nil {
		t.Fatal(err)
	}
	byGame := map[string]RecoveryAction{}
	for _, action := range actions {
		byGame[action.GameID] = action
	}
	if byGame["game-kept"].Kind != RecoveryKeep {
		t.Fatalf("an already honoured deletion should be kept: %+v", byGame["game-kept"])
	}
	if byGame["game-deleted-later"].Kind != RecoveryApply {
		t.Fatalf("a deletion newer than the restore must be applied: %+v", byGame["game-deleted-later"])
	}
	if byGame["game-deleted-later"].LiveDeleted != (time.Time{}) {
		t.Fatal("an applied tombstone cannot report a live deletion time")
	}
	if byGame["game-old"].Kind != RecoveryKeep || byGame["game-old"].LedgerDelete != day(1) {
		t.Fatalf("a live-only deletion must still be kept: %+v", byGame["game-old"])
	}
	counts := SummarizeRecovery(actions)
	if counts[RecoveryApply] != 1 || counts[RecoveryKeep] != 2 || counts[RecoveryRefresh] != 0 {
		t.Fatalf("unexpected recovery counts: %+v", counts)
	}
}

func TestPlanDeletionRecoveryRefreshesAnOlderLiveDeletion(t *testing.T) {
	live := []Tombstone{tombstone("game-a", day(5), 2, 1)}
	ledger := []Tombstone{tombstone("game-a", day(9), 4, 2)}
	actions, err := PlanDeletionRecovery(live, ledger)
	if err != nil {
		t.Fatal(err)
	}
	if len(actions) != 1 || actions[0].Kind != RecoveryRefresh || !actions[0].LiveDeleted.Equal(day(5)) {
		t.Fatalf("expected one refresh with the live time preserved: %+v", actions)
	}
}

func TestPlanDeletionRecoveryIsOrderIndependent(t *testing.T) {
	live := []Tombstone{tombstone("game-b", day(3), 2, 1), tombstone("game-a", day(4), 2, 1)}
	ledger := []Tombstone{tombstone("game-a", day(6), 5, 2), tombstone("game-c", day(5), 2, 1)}
	first, err := PlanDeletionRecovery(live, ledger)
	if err != nil {
		t.Fatal(err)
	}
	shuffledLive := []Tombstone{live[1], live[0]}
	shuffledLedger := []Tombstone{ledger[1], ledger[0]}
	second, err := PlanDeletionRecovery(shuffledLive, shuffledLedger)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != len(second) {
		t.Fatalf("plan length depends on input order: %d vs %d", len(first), len(second))
	}
	for index := range first {
		if first[index] != second[index] {
			t.Fatalf("recovery plan depends on input order at %d: %+v vs %+v", index, first[index], second[index])
		}
	}
}

func TestEncodeLedgerIsCanonical(t *testing.T) {
	first, err := EncodeLedger([]Tombstone{tombstone("game-b", day(2), 2, 1), tombstone("game-a", day(1), 1, 1)})
	if err != nil {
		t.Fatal(err)
	}
	second, err := EncodeLedger([]Tombstone{tombstone("game-a", day(1), 1, 1), tombstone("game-b", day(2), 2, 1)})
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatalf("ledger digest input is order dependent:\n%s\n%s", first, second)
	}
	if digestHex(first) != digestHex(second) {
		t.Fatal("ledger digest is order dependent")
	}
}
