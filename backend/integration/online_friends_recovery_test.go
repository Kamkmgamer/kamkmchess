package integration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The regressions of this file cover the recovery rules of the friend
// surface: one acceptance commits as a whole, an expired link says so, a
// named challenge stays invisible, and a rematch that lost its answer can be
// answered again.
//
// They run against a real PostgreSQL database and the real friend HTTP
// surface. Nothing here is a memory double.

// friendGuestAuthenticator resolves the real guest seat credentials.
//
// The account stub of the shipped friend test cannot authenticate a guest, so
// the guest paths of the surface need an authenticator that reaches the real
// credential service.
type friendGuestAuthenticator struct {
	accounts   map[string]onlineauth.Principal
	authorizer *onlineauth.Service
}

func (a *friendGuestAuthenticator) AuthenticateAccount(_ context.Context, token, origin string) (onlineauth.Principal, error) {
	principal, ok := a.accounts[token]
	if !ok || principal.Origin != origin {
		return onlineauth.Principal{}, onlineauth.ErrUnauthenticated
	}
	return principal, nil
}

func (a *friendGuestAuthenticator) AuthenticateGuest(ctx context.Context, secret, origin string) (onlineauth.Principal, error) {
	return a.authorizer.AuthenticateGuest(ctx, secret, origin)
}

// friendAuthorizer opens the real credential service of a fixture.
func friendAuthorizer(t *testing.T, pool *pgxpool.Pool) *onlineauth.Service {
	t.Helper()
	authorizer, err := onlineauth.Open(context.Background(), pool, nil, onlineauth.Options{GuestCredentialTTL: time.Hour, OwnershipProofTTL: 10 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	return authorizer
}

// friendGuestHandler mounts the real friend routes with a guest capable
// authenticator.
func friendGuestHandler(t *testing.T, fixture *friendFixture) (http.Handler, *onlineauth.Service) {
	t.Helper()
	authorizer := friendAuthorizer(t, fixture.pool)
	authenticator := &friendGuestAuthenticator{
		accounts:   map[string]onlineauth.Principal{},
		authorizer: authorizer,
	}
	handler := httpapi.NewFriends(fixture.friends, fixture.service, authenticator, httpapi.FriendsOptions{
		AllowedOrigins: []string{friendOrigin},
	})
	return handler, authorizer
}

// friendGuestRequest sends one request with a guest seat credential.
func friendGuestRequest(t *testing.T, handler http.Handler, method, path, guestToken, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Origin", friendOrigin)
	if guestToken != "" {
		request.Header.Set(httpapi.GuestCredentialHeader, guestToken)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// friendSeatLock holds the seats table of the test schema, so the creation of
// a match blocks while the acceptance of an invitation runs.
type friendSeatLock struct {
	conn *pgx.Conn
}

// friendLockSeats locks the seats table of the schema of a pool.
func friendLockSeats(t *testing.T, pool *pgxpool.Pool) *friendSeatLock {
	t.Helper()
	ctx := context.Background()
	dsn := os.Getenv(databaseEnv)
	if dsn == "" {
		t.Fatalf("%s is required", databaseEnv)
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = pool.Config().ConnConfig.RuntimeParams["search_path"]
	conn, err := pgx.ConnectConfig(ctx, cfg.ConnConfig)
	if err != nil {
		t.Fatalf("connect the locking session: %v", err)
	}
	if _, err = conn.Exec(ctx, "BEGIN"); err != nil {
		conn.Close(ctx)
		t.Fatalf("begin the locking session: %v", err)
	}
	if _, err = conn.Exec(ctx, "LOCK TABLE online_seats IN ACCESS EXCLUSIVE MODE"); err != nil {
		conn.Close(ctx)
		t.Fatalf("lock the seats table: %v", err)
	}
	return &friendSeatLock{conn: conn}
}

// release gives the seats table back.
func (l *friendSeatLock) release(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	if l.conn == nil {
		return
	}
	_, _ = l.conn.Exec(ctx, "ROLLBACK")
	_ = l.conn.Close(ctx)
	l.conn = nil
}

// waitForBlockedSeatInsert waits until a statement waits for the seats table.
//
// The wait proves that the acceptance reached the creation of the match and
// waits there, so the crash below happens in the middle of the acceptance
// and not before it.
func waitForBlockedSeatInsert(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var waiting int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%online_seats%'`).Scan(&waiting)
		if err == nil && waiting > 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the acceptance never reached the creation of the match")
}

// TestPostgresFriendAcceptanceCommitsTheMatchAndTheCredentialTogether
// covers the atomicity of one acceptance.
//
// The consumption of the invitation, the acceptance record, the canonical
// match and the guest seat credential have to commit together. A crash
// between two of them would leave a spent invitation without a game, and no
// service would ever revisit it.
func TestPostgresFriendAcceptanceCommitsTheMatchAndTheCredentialTogether(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	key := acceptanceKey("atomic-acceptance")
	locker := friendLockSeats(t, fixture.pool)
	acceptCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		_, acceptErr := fixture.friends.Accept(acceptCtx, invite.AcceptRequest{
			InvitationID:  created.Invitation.InvitationID,
			AcceptanceKey: key,
			Acceptor:      friendIdentity("user_invitee", "Bob"),
			Control:       online.SeatControl{Kind: online.ControlHuman},
			Origin:        friendOrigin,
		})
		done <- acceptErr
	}()
	// The acceptance waits for the seats table, so the match does not exist
	// yet while the acceptance is running.
	waitForBlockedSeatInsert(t, fixture.pool)
	cancel()
	if acceptErr := <-done; acceptErr == nil {
		t.Fatal("the cancelled acceptance reported success")
	}
	locker.release(t)

	// The crash left nothing behind: the invitation is not spent, no
	// acceptance was recorded and no match exists.
	var (
		status    string
		matchID   *string
		expiresAt time.Time
	)
	if err = fixture.pool.QueryRow(ctx, `SELECT status,match_id,expires_at FROM online_friend_invitations WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&status, &matchID, &expiresAt); err != nil {
		t.Fatal(err)
	}
	if status != "open" || matchID != nil {
		t.Fatalf("the invitation after the crash = %q/%v, want open/null", status, matchID)
	}
	var acceptances int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_invitation_acceptances WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&acceptances); err != nil {
		t.Fatal(err)
	}
	if acceptances != 0 {
		t.Fatalf("the crashed acceptance recorded %d acceptances", acceptances)
	}
	var matches int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches`).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 0 {
		t.Fatalf("the crashed acceptance created %d matches", matches)
	}
	// The invitation is still usable: the same key accepts it and creates
	// exactly one game.
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: key,
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept after the crash: %v", err)
	}
	if accepted.MatchID == "" {
		t.Fatal("the acceptance after the crash created no match")
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, accepted.MatchID).Scan(&matches); err != nil {
		t.Fatal(err)
	}
	if matches != 1 {
		t.Fatalf("the accepted invitation produced %d matches", matches)
	}
}

// TestPostgresFriendExpiredInvitationReportsItsState covers the effective
// expiry of an invitation.
//
// The deadline is a property of the invitation, so an invitation whose
// deadline passed is expired even though no sweep ever wrote that state. The
// preview has to say so, and the refused acceptance has to say so as well,
// so the browser can tell the invitee that the link expired.
func TestPostgresFriendExpiredInvitationReportsItsState(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err = fixture.pool.Exec(ctx, `UPDATE online_friend_invitations SET created_at=clock_timestamp()-interval '13 hours', expires_at=clock_timestamp()-interval '1 hour' WHERE invitation_id=$1`, created.Invitation.InvitationID); err != nil {
		t.Fatal(err)
	}
	// The preview reports the effective state.
	preview, err := fixture.friends.Get(ctx, created.Invitation.InvitationID, "")
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if preview.Status != invite.StatusExpired {
		t.Fatalf("the preview of an expired invitation = %q, want expired", preview.Status)
	}
	// The acceptance is refused with the expiry, not with a conflict.
	if _, err = fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("expired-state"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	}); !errors.Is(err, invite.ErrExpired) {
		t.Fatalf("expired acceptance error = %v, want ErrExpired", err)
	}
	// The HTTP surface answers the expiry with its own status and its own
	// code, so the browser can tell it apart from a spent link.
	handler, _ := friendGuestHandler(t, fixture)
	recorder := friendGuestRequest(t, handler, http.MethodPost,
		"/v1/online/invitations/"+created.Invitation.InvitationID+"/accept", "",
		`{"schemaVersion":2,"acceptanceKey":"expired-state-acceptance-key-0123456789","control":{"kind":"human"}}`)
	if recorder.Code != http.StatusGone {
		t.Fatalf("the expired acceptance status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Error string `json:"error"`
	}
	if err = json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error != "expired" {
		t.Fatalf("the expired acceptance error code = %q, want expired", body.Error)
	}
	// The preview over HTTP reports the expired state as well.
	previewRecorder := friendGuestRequest(t, handler, http.MethodGet,
		"/v1/online/invitations/"+created.Invitation.InvitationID, "", "")
	if previewRecorder.Code != http.StatusOK {
		t.Fatalf("the preview status = %d body=%s", previewRecorder.Code, previewRecorder.Body.String())
	}
	var previewBody struct {
		Status string `json:"status"`
	}
	if err = json.Unmarshal(previewRecorder.Body.Bytes(), &previewBody); err != nil {
		t.Fatal(err)
	}
	if previewBody.Status != "expired" {
		t.Fatalf("the preview status = %q, want expired", previewBody.Status)
	}
}

// TestPostgresFriendNamedChallengeIsInvisibleToAStranger covers the
// isolation of a named challenge.
//
// The preview of a challenge is already invisible to a stranger. The
// acceptance has to answer the same status as an unknown invitation, so a
// caller cannot learn that a named challenge exists.
func TestPostgresFriendNamedChallengeIsInvisibleToAStranger(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Kind:               invite.KindChallenge,
		Inviter:            friendIdentity("user_inviter", "Alice"),
		RecipientAccountID: "user_recipient",
		Seat:               online.SeatWhite,
		TimeControl:        online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:            online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	handler, _ := friendGuestHandler(t, fixture)
	challenge := friendGuestRequest(t, handler, http.MethodPost,
		"/v1/online/invitations/"+created.Invitation.InvitationID+"/accept", "",
		`{"schemaVersion":2,"acceptanceKey":"stranger-acceptance-key-0123456789","control":{"kind":"human"}}`)
	unknown := friendGuestRequest(t, handler, http.MethodPost,
		"/v1/online/invitations/inv_thisdoesnotexist000000000000000000/accept", "",
		`{"schemaVersion":2,"acceptanceKey":"unknown-acceptance-key-0123456789","control":{"kind":"human"}}`)
	if challenge.Code != http.StatusNotFound {
		t.Fatalf("the challenge acceptance status = %d body=%s", challenge.Code, challenge.Body.String())
	}
	if unknown.Code != challenge.Code {
		t.Fatalf("the unknown invitation status = %d, want %d", unknown.Code, challenge.Code)
	}
	// The challenge is untouched: a refused acceptance consumes nothing.
	preview, err := fixture.friends.Get(ctx, created.Invitation.InvitationID, "user_recipient")
	if err != nil {
		t.Fatal(err)
	}
	if preview.Status != invite.StatusOpen {
		t.Fatalf("the challenge status after the refused acceptance = %q, want open", preview.Status)
	}
}

// TestPostgresFriendGuestRematchLostAnswerRecoversTheCredential covers the
// rematch whose answer was lost.
//
// A rematch is a new match, so the credential of the finished match cannot
// authorize the new seat. A guest accepter that lost the answer holds no
// working credential of the new match, so the retry has to answer with a
// fresh one.
func TestPostgresFriendGuestRematchLostAnswerRecoversTheCredential(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()
	authorizer := friendAuthorizer(t, fixture.pool)

	// An anonymous guest inviter and a guest acceptor.
	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("rematch-recovery"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	claimed, err := fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
		Origin:       friendOrigin,
	})
	if err != nil {
		t.Fatalf("claim the inviter credential: %v", err)
	}
	inviterPrincipal, err := authorizer.AuthenticateGuest(ctx, claimed.GuestCredential.Token, friendOrigin)
	if err != nil {
		t.Fatalf("authenticate the inviter credential: %v", err)
	}
	// The finished match ends.
	resign := resignOnlineCommand(accepted.MatchID, "rematch-recovery-resign", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(onlineauth.WithPrincipal(ctx, inviterPrincipal), inviterPrincipal.Participant, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	proposal, err := fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       accepted.MatchID,
		Proposer:      inviterPrincipal.Participant,
		ProposerLabel: invite.GuestLabel,
	})
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	acceptor := online.ParticipantRef{Kind: online.ParticipantGuest, ID: accepted.GuestCredential.GuestID}
	first, err := fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
		RematchID: proposal.RematchID,
		Acceptor:  acceptor,
		Origin:    friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept the rematch: %v", err)
	}
	if first.GuestCredential == nil || first.GuestCredential.MatchID != first.MatchID {
		t.Fatalf("the rematch acceptance delivered no credential of the new match: %+v", first)
	}
	// The answer is lost. The browser retries the same acceptance and still
	// holds the credential of the finished match, so it holds no working
	// credential of the new match.
	retry, err := fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
		RematchID:         proposal.RematchID,
		Acceptor:          acceptor,
		Origin:            friendOrigin,
		CredentialMatchID: accepted.MatchID,
	})
	if err != nil {
		t.Fatalf("retry the rematch: %v", err)
	}
	if retry.MatchID != first.MatchID {
		t.Fatalf("the retry created %q, want %q", retry.MatchID, first.MatchID)
	}
	if retry.GuestCredential == nil {
		t.Fatal("the retry of a lost answer delivered no credential of the new match")
	}
	if retry.GuestCredential.MatchID != first.MatchID {
		t.Fatalf("the retried credential names %q, want %q", retry.GuestCredential.MatchID, first.MatchID)
	}
	// The retried credential authorizes the new match.
	recovered, err := authorizer.AuthenticateGuest(ctx, retry.GuestCredential.Token, friendOrigin)
	if err != nil {
		t.Fatalf("authenticate the retried credential: %v", err)
	}
	if recovered.MatchID != first.MatchID || recovered.Seat != first.Seat {
		t.Fatalf("the retried principal = %+v", recovered)
	}
	// The credential of the first answer no longer authorizes the seat.
	if _, err = authorizer.AuthenticateGuest(ctx, first.GuestCredential.Token, friendOrigin); !errors.Is(err, onlineauth.ErrUnauthenticated) {
		t.Fatalf("the superseded credential error = %v, want ErrUnauthenticated", err)
	}
	// A caller that already holds a working credential of the new match
	// keeps it: the retry never supersedes a delivered credential.
	again, err := fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
		RematchID:         proposal.RematchID,
		Acceptor:          acceptor,
		Origin:            friendOrigin,
		CredentialMatchID: first.MatchID,
	})
	if err != nil {
		t.Fatalf("retry with a working credential: %v", err)
	}
	if again.GuestCredential != nil {
		t.Fatal("the retry superseded a credential the caller already holds")
	}
	// Exactly one new match exists.
	var newMatches int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, first.MatchID).Scan(&newMatches); err != nil {
		t.Fatal(err)
	}
	if newMatches != 1 {
		t.Fatalf("the rematch produced %d matches", newMatches)
	}
}

// TestPostgresFriendGuestRematchRetryAnswersTheLiveView covers the same
// recovery over the real HTTP surface.
//
// The answer of a rematch carries the live view of the new match. A guest
// that lost the answer has to get that view back, together with a working
// credential of the new match.
func TestPostgresFriendGuestRematchRetryAnswersTheLiveView(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()
	handler, authorizer := friendGuestHandler(t, fixture)

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("rematch-http"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	claimed, err := fixture.friends.SeatCredential(ctx, invite.SeatCredentialRequest{
		InvitationID: created.Invitation.InvitationID,
		OwnerToken:   created.OwnerToken,
		Origin:       friendOrigin,
	})
	if err != nil {
		t.Fatalf("claim the inviter credential: %v", err)
	}
	inviterPrincipal, err := authorizer.AuthenticateGuest(ctx, claimed.GuestCredential.Token, friendOrigin)
	if err != nil {
		t.Fatalf("authenticate the inviter credential: %v", err)
	}
	resign := resignOnlineCommand(accepted.MatchID, "rematch-http-resign", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(onlineauth.WithPrincipal(ctx, inviterPrincipal), inviterPrincipal.Participant, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	proposal, err := fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       accepted.MatchID,
		Proposer:      inviterPrincipal.Participant,
		ProposerLabel: invite.GuestLabel,
	})
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	acceptPath := "/v1/online/rematches/" + proposal.RematchID + "/accept"
	first := friendGuestRequest(t, handler, http.MethodPost, acceptPath, accepted.GuestCredential.Token, `{"schemaVersion":2}`)
	if first.Code != http.StatusOK {
		t.Fatalf("the rematch acceptance status = %d body=%s", first.Code, first.Body.String())
	}
	var firstBody struct {
		Match struct {
			MatchID string `json:"matchId"`
		} `json:"match"`
		GuestCredential *struct {
			Token string `json:"token"`
		} `json:"guestCredential"`
	}
	if err = json.Unmarshal(first.Body.Bytes(), &firstBody); err != nil {
		t.Fatal(err)
	}
	if firstBody.GuestCredential == nil || firstBody.Match.MatchID == "" {
		t.Fatalf("the rematch answer is incomplete: %s", first.Body.String())
	}
	// The answer is lost. The browser retries with the credential of the
	// finished match and asks for the replacement of the credential.
	retry := friendGuestRequest(t, handler, http.MethodPost, acceptPath, accepted.GuestCredential.Token,
		`{"schemaVersion":2,"rotateCredential":true}`)
	if retry.Code != http.StatusOK {
		t.Fatalf("the rematch retry status = %d body=%s", retry.Code, retry.Body.String())
	}
	var retryBody struct {
		Match struct {
			MatchID string `json:"matchId"`
		} `json:"match"`
		GuestCredential *struct {
			Token   string `json:"token"`
			MatchID string `json:"matchId"`
		} `json:"guestCredential"`
	}
	if err = json.Unmarshal(retry.Body.Bytes(), &retryBody); err != nil {
		t.Fatal(err)
	}
	if retryBody.Match.MatchID != firstBody.Match.MatchID {
		t.Fatalf("the retry named %q, want %q", retryBody.Match.MatchID, firstBody.Match.MatchID)
	}
	if retryBody.GuestCredential == nil || retryBody.GuestCredential.Token == "" {
		t.Fatalf("the retry delivered no credential: %s", retry.Body.String())
	}
	if retryBody.GuestCredential.MatchID != firstBody.Match.MatchID {
		t.Fatalf("the retried credential names %q, want %q", retryBody.GuestCredential.MatchID, firstBody.Match.MatchID)
	}
	// The retried credential authorizes the new match.
	recovered, err := authorizer.AuthenticateGuest(ctx, retryBody.GuestCredential.Token, friendOrigin)
	if err != nil {
		t.Fatalf("authenticate the retried credential: %v", err)
	}
	if recovered.MatchID != firstBody.Match.MatchID {
		t.Fatalf("the retried principal names %q, want %q", recovered.MatchID, firstBody.Match.MatchID)
	}
}

// TestPostgresFriendRematchAcceptanceCommitsTheOfferAndTheMatchTogether
// covers the atomicity of a rematch acceptance.
//
// The offer, the new match and the credential of the accepter commit
// together. A crash in the middle has to leave the offer open for the
// opponent, because a durable reservation without a game would strand the
// rematch until the offer expires.
func TestPostgresFriendRematchAcceptanceCommitsTheOfferAndTheMatchTogether(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("rematch-atomic"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	resign := resignOnlineCommand(accepted.MatchID, "rematch-atomic-resign", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_inviter", "session_rematch"), online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	proposal, err := fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       accepted.MatchID,
		Proposer:      online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"},
		ProposerLabel: "Alice",
	})
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	locker := friendLockSeats(t, fixture.pool)
	acceptCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		_, acceptErr := fixture.friends.AcceptRematch(acceptCtx, invite.AcceptRematchRequest{
			RematchID: proposal.RematchID,
			Acceptor:  online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_invitee"},
		})
		done <- acceptErr
	}()
	waitForBlockedSeatInsert(t, fixture.pool)
	cancel()
	if acceptErr := <-done; acceptErr == nil {
		t.Fatal("the cancelled rematch acceptance reported success")
	}
	locker.release(t)

	// The offer is still open and no match was created.
	var (
		status     string
		newMatchID *string
		acceptedBy *string
	)
	if err = fixture.pool.QueryRow(ctx, `SELECT status,new_match_id,accepted_by_id FROM online_rematch_offers WHERE rematch_id=$1`, proposal.RematchID).Scan(&status, &newMatchID, &acceptedBy); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || newMatchID != nil {
		t.Fatalf("the offer after the crash = %q/%v, want pending/null", status, newMatchID)
	}
	if acceptedBy != nil {
		t.Fatalf("the offer after the crash names the accepter %q", *acceptedBy)
	}
	var newMatches int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id<>$1`, accepted.MatchID).Scan(&newMatches); err != nil {
		t.Fatal(err)
	}
	if newMatches != 0 {
		t.Fatalf("the crashed rematch created %d matches", newMatches)
	}
	// The opponent may still accept the offer, and it creates exactly one
	// new match.
	result, err := fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
		RematchID: proposal.RematchID,
		Acceptor:  online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_invitee"},
	})
	if err != nil {
		t.Fatalf("accept the rematch after the crash: %v", err)
	}
	if result.MatchID == "" || result.MatchID == accepted.MatchID {
		t.Fatalf("the rematch created %q", result.MatchID)
	}
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, result.MatchID).Scan(&newMatches); err != nil {
		t.Fatal(err)
	}
	if newMatches != 1 {
		t.Fatalf("the accepted rematch produced %d matches", newMatches)
	}
}

// TestPostgresFriendConcurrentAcceptanceAndCancellationHaveOneWinner covers
// the bounded race of a cancellation against a set of acceptances.
//
// Exactly one of the two wins: either the cancellation spends the
// invitation and no acceptance creates a game, or one acceptance creates one
// game and the cancellation reports the real state.
func TestPostgresFriendConcurrentAcceptanceAndCancellationHaveOneWinner(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	const racers = 8
	type outcome struct {
		matchID string
		err     error
	}
	results := make(chan outcome, racers)
	cancelled := make(chan error, 1)
	var wait sync.WaitGroup
	for index := 0; index < racers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			accepted, acceptErr := fixture.friends.Accept(ctx, invite.AcceptRequest{
				InvitationID:  created.Invitation.InvitationID,
				AcceptanceKey: acceptanceKey(fmt.Sprintf("race-cancel-%d", index)),
				Acceptor:      friendIdentity(fmt.Sprintf("user_racer_%d", index), "Racer"),
				Control:       online.SeatControl{Kind: online.ControlHuman},
				Origin:        friendOrigin,
			})
			results <- outcome{matchID: accepted.MatchID, err: acceptErr}
		}(index)
	}
	wait.Add(1)
	go func() {
		defer wait.Done()
		_, cancelErr := fixture.friends.Cancel(ctx, invite.CancelRequest{
			InvitationID: created.Invitation.InvitationID,
			OwnerToken:   created.OwnerToken,
		})
		cancelled <- cancelErr
	}()
	wait.Wait()
	close(results)

	winners := 0
	var winnerMatch string
	for result := range results {
		if result.err != nil {
			if !errors.Is(result.err, invite.ErrAlreadyConsumed) && !errors.Is(result.err, invite.ErrConflict) {
				t.Fatalf("a losing racer returned %v", result.err)
			}
			continue
		}
		winners++
		winnerMatch = result.matchID
	}
	if winners > 1 {
		t.Fatalf("the race produced %d winners", winners)
	}
	// The cancellation either won or lost against the single winner.
	switch cancelErr := <-cancelled; {
	case cancelErr == nil && winners != 0:
		t.Fatalf("the cancellation and the acceptance both won")
	case cancelErr != nil && !errors.Is(cancelErr, invite.ErrConflict):
		t.Fatalf("the losing cancellation returned %v", cancelErr)
	}
	var acceptances int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_invitation_acceptances WHERE invitation_id=$1`, created.Invitation.InvitationID).Scan(&acceptances); err != nil {
		t.Fatal(err)
	}
	if acceptances != winners {
		t.Fatalf("the invitation recorded %d acceptances for %d winners", acceptances, winners)
	}
	if winners == 1 {
		var matches int
		if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, winnerMatch).Scan(&matches); err != nil {
			t.Fatal(err)
		}
		if matches != 1 {
			t.Fatalf("the winning acceptance produced %d matches", matches)
		}
	}
	// The state of the invitation is one of the two real states.
	preview, err := fixture.friends.Get(ctx, created.Invitation.InvitationID, "")
	if err != nil {
		t.Fatal(err)
	}
	if preview.Status != invite.StatusConsumed && preview.Status != invite.StatusCancelled {
		t.Fatalf("the invitation after the race = %q", preview.Status)
	}
	if preview.Status == invite.StatusConsumed && preview.MatchID == nil {
		t.Fatal("a consumed invitation lost its match")
	}
	if preview.Status == invite.StatusCancelled && preview.MatchID != nil {
		t.Fatal("a cancelled invitation kept a match")
	}
}

// TestPostgresFriendConcurrentRematchAcceptanceCreatesOneMatch covers the
// bounded race of many acceptances of one rematch offer.
//
// Every acceptance of the same offer names the same new match, and only one
// match exists afterwards.
func TestPostgresFriendConcurrentRematchAcceptanceCreatesOneMatch(t *testing.T) {
	fixture := newFriendFixture(t, moveEvaluator{})
	ctx := context.Background()

	created, err := fixture.friends.Create(ctx, invite.CreateRequest{
		Inviter:     friendIdentity("user_inviter", "Alice"),
		Seat:        online.SeatWhite,
		TimeControl: online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:     online.SeatControl{Kind: online.ControlHuman},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	accepted, err := fixture.friends.Accept(ctx, invite.AcceptRequest{
		InvitationID:  created.Invitation.InvitationID,
		AcceptanceKey: acceptanceKey("rematch-race"),
		Acceptor:      friendIdentity("user_invitee", "Bob"),
		Control:       online.SeatControl{Kind: online.ControlHuman},
		Origin:        friendOrigin,
	})
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	resign := resignOnlineCommand(accepted.MatchID, "rematch-race-resign", online.SeatWhite, 1)
	if _, err = fixture.service.Execute(accountContext("user_inviter", "session_rematch"), online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, resign); err != nil {
		t.Fatalf("resign: %v", err)
	}
	proposal, err := fixture.friends.ProposeRematch(ctx, invite.RematchRequest{
		MatchID:       accepted.MatchID,
		Proposer:      online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"},
		ProposerLabel: "Alice",
	})
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	const racers = 8
	type outcome struct {
		matchID string
		err     error
	}
	results := make(chan outcome, racers)
	var wait sync.WaitGroup
	for index := 0; index < racers; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, acceptErr := fixture.friends.AcceptRematch(ctx, invite.AcceptRematchRequest{
				RematchID: proposal.RematchID,
				Acceptor:  online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_invitee"},
			})
			results <- outcome{matchID: result.MatchID, err: acceptErr}
		}()
	}
	wait.Wait()
	close(results)
	seen := map[string]int{}
	for result := range results {
		if result.err != nil {
			t.Fatalf("a concurrent rematch acceptance returned %v", result.err)
		}
		seen[result.matchID]++
	}
	if len(seen) != 1 {
		t.Fatalf("the concurrent rematch acceptance named %d matches", len(seen))
	}
	for matchID := range seen {
		var matches int
		if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_matches WHERE match_id=$1`, matchID).Scan(&matches); err != nil {
			t.Fatal(err)
		}
		if matches != 1 {
			t.Fatalf("the accepted rematch produced %d matches", matches)
		}
	}
	// The offer names the new match exactly once.
	var offers int
	if err = fixture.pool.QueryRow(ctx, `SELECT count(*) FROM online_rematch_offers WHERE rematch_id=$1 AND new_match_id IS NOT NULL`, proposal.RematchID).Scan(&offers); err != nil {
		t.Fatal(err)
	}
	if offers != 1 {
		t.Fatalf("the offer recorded %d new matches", offers)
	}
}
