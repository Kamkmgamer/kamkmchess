package integration

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/history"
	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/profile"
)

// privacyUnprojectedMatch plays one completed online game between two
// accounts without publishing it.
func privacyUnprojectedMatch(t *testing.T, fixture *onlineAuthFixture, matchID string) {
	t.Helper()
	white := accountSeat{Subject: "user_a", Seat: online.SeatWhite}
	black := accountSeat{Subject: "user_b", Seat: online.SeatBlack}
	historyCreate(t, fixture, matchID, white, black, online.SeatControl{Kind: online.ControlHuman}, online.SeatControl{Kind: online.ControlHuman})
	historyExecute(t, fixture, matchID, "op-move-"+matchID, white, 1, 1, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: "e2e4"}})
	historyExecute(t, fixture, matchID, "op-resign-"+matchID, black, 2, 1, online.Action{Kind: online.ActionResign})
}

// TestPostgresRemovalWaitsForTheAccountScopeLock covers the lock protocol
// between the trusted allocation and the removal.
//
// The allocation and the removal take the same account scope lock, so a seat
// of a removed participant is never allocated while the removal runs.
func TestPostgresRemovalWaitsForTheAccountScopeLock(t *testing.T) {
	fixture, removals, _ := privacyFixture(t)
	matchID := "privacy-lock-match"
	privacyUnprojectedMatch(t, fixture, matchID)

	ctx := context.Background()
	// The lock of the trusted allocation.
	held, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback(ctx)
	if err = locks.LockAccountScope(ctx, held, locks.AccountScope(string(online.ParticipantAccount), "user_a")); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := removals.RemoveAccount(ctx, accountPrincipal("user_a", "session-user_a"), authTestOrigin)
		done <- err
	}()
	select {
	case err = <-done:
		t.Fatalf("the removal did not wait for the account scope lock: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	// The allocation of a seat for the same participant is ordered against the
	// removal as well.
	allocation, err := fixture.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	allocationDone := make(chan error, 1)
	go func() {
		allocationDone <- locks.LockAccountScope(ctx, allocation, locks.AccountScope(string(online.ParticipantAccount), "user_a"))
	}()
	select {
	case err = <-allocationDone:
		_ = allocation.Rollback(ctx)
		t.Fatalf("the allocation did not wait for the account scope lock: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	// The lock is released and both flows continue.
	if err = held.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err != nil {
		t.Fatalf("the removal failed: %v", err)
	}
	if err = <-allocationDone; err != nil {
		t.Fatalf("the allocation failed: %v", err)
	}
	_ = allocation.Rollback(ctx)
}

// TestPostgresConcurrentFirstProjectionAndRemovalNeverRepublishes covers the
// race between the first publication of a game and its removal.
//
// The publication and the removal take the same match lock, so the removed
// game is never published with the name of the removed participant, and it
// never reappears in the history of the opponent.
func TestPostgresConcurrentFirstProjectionAndRemovalNeverRepublishes(t *testing.T) {
	for attempt := 0; attempt < 5; attempt++ {
		fixture, removals, historyService := privacyFixture(t)
		matchID := "privacy-race-match"
		privacyUnprojectedMatch(t, fixture, matchID)
		// Both accounts have a public profile before the race, so the
		// projection does not have to create one while it runs.
		resolver, err := profileServiceFor(t, fixture)
		if err != nil {
			t.Fatal(err)
		}
		for _, account := range []string{"user_a", "user_b"} {
			if _, err = resolver.EnsureProfileForAccount(context.Background(), account); err != nil {
				t.Fatal(err)
			}
		}
		keptProfile := privacyProfileID(t, fixture, "user_b")

		var group sync.WaitGroup
		start := make(chan struct{})
		projectErr := make(chan error, 1)
		removeErr := make(chan error, 1)
		group.Add(2)
		go func() {
			defer group.Done()
			<-start
			_, err := historyService.ProjectMatch(context.Background(), matchID)
			projectErr <- err
		}()
		go func() {
			defer group.Done()
			<-start
			_, err := removals.RemoveAccount(context.Background(), accountPrincipal("user_a", "session-user_a"), authTestOrigin)
			removeErr <- err
		}()
		close(start)
		group.Wait()
		// The projection may report the removed game as not found, and the
		// removal never fails.
		if err := <-projectErr; err != nil && err != history.ErrNotFound {
			t.Fatalf("the projection failed: %v", err)
		}
		if err := <-removeErr; err != nil {
			t.Fatalf("the removal failed: %v", err)
		}

		// The removed name is never published.
		replay, err := historyService.PublicReplay(context.Background(), matchID)
		if err == nil {
			raw := replay
			for _, participant := range raw.Participants {
				if participant.PublicLabel == "Alice" {
					t.Fatalf("attempt %d: the public replay still names the removed participant: %+v", attempt, raw)
				}
			}
		}
		// The game never reappears in the history of the opponent.
		record, err := historyService.ProfileHistory(context.Background(), keptProfile)
		if err != nil {
			t.Fatal(err)
		}
		for _, game := range record.Games {
			if game.MatchID == matchID && game.OpponentLabel == "Alice" {
				t.Fatalf("attempt %d: the history of the opponent still names the removed participant: %+v", attempt, game)
			}
		}
		// The removal is recorded in the durable ledger, and the seat of the
		// removed participant never names it again.
		records, err := removals.ListRemovalRecords(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, removalRecord := range records {
			if removalRecord.MatchID == matchID {
				found = true
			}
		}
		if !found {
			t.Fatalf("attempt %d: the removal is not in the ledger: %+v", attempt, records)
		}
		var ownerID string
		if err = fixture.pool.QueryRow(context.Background(), `SELECT owner_id FROM online_seats WHERE match_id=$1 AND seat='white'`, matchID).Scan(&ownerID); err != nil {
			t.Fatal(err)
		}
		if ownerID != "anonymized" {
			t.Fatalf("attempt %d: the seat still names the removed participant: %q", attempt, ownerID)
		}
		// The removal tables never keep the raw identifier of the subject.
		var rawIdentifiers int
		if err = fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_removal_requests WHERE subject_id='user_a'`).Scan(&rawIdentifiers); err != nil {
			t.Fatal(err)
		}
		if rawIdentifiers != 0 {
			t.Fatalf("attempt %d: the removal request keeps the raw subject identifier", attempt)
		}
		var rawLedger int
		if err = fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_removal_ledger WHERE subject_id='user_a'`).Scan(&rawLedger); err != nil {
			t.Fatal(err)
		}
		if rawLedger != 0 {
			t.Fatalf("attempt %d: the removal ledger keeps the raw subject identifier", attempt)
		}
	}
}

// TestPostgresDeletionDoesNotLetTheProfilePublishANameAgain covers the
// closed profile of a deleted account.
//
// The public name of a deleted account is gone, and the profile routes refuse
// to publish one again.
func TestPostgresDeletionDoesNotLetTheProfilePublishANameAgain(t *testing.T) {
	fixture, removals, historyService := privacyFixture(t)
	matchID := "privacy-closed-profile-match"
	privacyUnprojectedMatch(t, fixture, matchID)
	resolver, err := profileServiceFor(t, fixture)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = resolver.EnsureProfileForAccount(context.Background(), "user_a"); err != nil {
		t.Fatal(err)
	}
	// The account publishes a name before the deletion.
	name := "deletedplayer"
	if _, err = resolver.UpdateProfile(context.Background(), accountPrincipal("user_a", "session-user_a"), profile.Update{Username: &name}, authTestOrigin); err != nil {
		t.Fatalf("update profile: %v", err)
	}
	profileID := privacyProfileID(t, fixture, "user_a")
	if _, err = removals.DeleteAccount(context.Background(), accountPrincipal("user_a", "session-user_a"), authTestOrigin); err != nil {
		t.Fatalf("delete account: %v", err)
	}
	// The name is gone.
	var username string
	if err := fixture.pool.QueryRow(context.Background(), `SELECT coalesce(username,'') FROM online_public_profiles WHERE profile_id=$1`, profileID).Scan(&username); err != nil {
		t.Fatal(err)
	}
	if username != "" {
		t.Fatalf("the deleted account keeps the public name %q", username)
	}
	// The old public name finds nothing, so the name of a deleted account can
	// never be published or linked again.
	lookup := onlineHTTPRequest(profileHTTPFixture(t, fixture), http.MethodGet, "/v1/profiles/username/"+name, authTestOrigin, "", nil, "")
	if lookup.Code != http.StatusNotFound {
		t.Fatalf("the name of the deleted account is still published: status=%d body=%s", lookup.Code, lookup.Body.String())
	}
	// The profile seam refuses the deleted account, so the publisher never
	// creates a profile for it again.
	created, err := resolver.EnsureProfileForAccount(context.Background(), "user_a")
	if err != nil {
		t.Fatalf("ensure profile: %v", err)
	}
	if created != "" {
		t.Fatalf("the deleted account got a profile again: %q", created)
	}
	// The projection never counts a result for the deleted account again.
	if _, err = historyService.ProjectMatch(context.Background(), matchID); err != nil && err != history.ErrNotFound {
		t.Fatalf("project match: %v", err)
	}
	var rows int
	if err = fixture.pool.QueryRow(context.Background(), `SELECT count(*) FROM online_profile_results WHERE profile_id=$1`, profileID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("the deleted account has %d public history rows", rows)
	}
	// The public history of the opponent keeps the anonymized entry only.
	keptProfile := privacyProfileID(t, fixture, "user_b")
	record, err := historyService.ProfileHistory(context.Background(), keptProfile)
	if err != nil {
		t.Fatal(err)
	}
	for _, game := range record.Games {
		if strings.Contains(game.OpponentLabel, "Alice") {
			t.Fatalf("the history of the opponent names the removed participant: %+v", game)
		}
	}
}
