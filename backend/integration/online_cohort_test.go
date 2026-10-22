package integration

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/cohort"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The cohort tests drive the composed service.
//
// The composition is the only place where the server configuration, the
// request path and the durable state meet, so these tests prove the whole
// chain: the setting reaches the request path, an account outside the cohort
// is refused, a guest is never refused, and a match that already exists keeps
// being served.

// cohortOrigin is the origin of the composed requests.
const cohortOrigin = "https://app.example"

// cohortClerk serves the identity document of the composition.
//
// It returns the key that signs its sessions, so a test can play an account.
func cohortClerk(t *testing.T) (auth.Config, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate the signing key: %v", err)
	}
	document := fmt.Sprintf(`{"keys":[{"kty":"RSA","kid":"cohort-key","use":"sig","alg":"RS256","n":%q,"e":"AQAB"}]}`,
		base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()))
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/jwks.json" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(document))
	}))
	t.Cleanup(server.Close)
	config := auth.Config{
		Issuer:            server.URL,
		JWKSURL:           server.URL + "/.well-known/jwks.json",
		AuthorizedParties: []string{cohortOrigin},
		AllowedOrigins:    []string{cohortOrigin},
		HTTPClient:        server.Client(),
	}
	return config, key
}

// cohortSession signs a session of an account.
func cohortSession(t *testing.T, key *rsa.PrivateKey, issuer, subject string) string {
	t.Helper()
	encode := func(value []byte) string { return base64.RawURLEncoding.EncodeToString(value) }
	header := encode([]byte(`{"alg":"RS256","kid":"cohort-key","typ":"JWT"}`))
	claims := encode([]byte(fmt.Sprintf(`{"iss":%q,"sub":%q,"sid":"session-%s","azp":%q,"exp":%d,"token_use":"session"}`,
		issuer, subject, subject, cohortOrigin, time.Now().Add(time.Hour).Unix())))
	input := header + "." + claims
	digest := sha256.Sum256([]byte(input))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatalf("sign the session: %v", err)
	}
	return input + "." + encode(signature)
}

// cohortRequest sends one request to the composed service.
func cohortRequest(handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Origin", cohortOrigin)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

// cohortComposition boots the composed service on the isolated schema.
//
// The rules worker is the fixture worker of the composition proof, so the
// service can validate a starting position without a hosted dependency.
func cohortComposition(t *testing.T, pool *pgxpool.Pool, worker *fixtureRulesWorker, clerk auth.Config, online serverapp.OnlineConfig) http.Handler {
	t.Helper()
	databaseURL := scopedDatabaseURL(t, pool)
	// The durable restore fence is required by the composition. The fixture
	// owns one, so the composition observes a fence that no restore holds.
	online.RestoreFencePath = t.TempDir()
	handler, release, err := serverapp.Open(context.Background(), serverapp.Config{
		DatabaseURL: databaseURL,
		Clerk:       clerk,
		Online:      online,
	})
	if err != nil {
		t.Fatalf("compose the service: %v", err)
	}
	t.Cleanup(release)
	return handler
}

// cohortOnlineConfig is the configuration of a composition that serves the
// friend and the queue surface.
func cohortOnlineConfig(worker *fixtureRulesWorker) serverapp.OnlineConfig {
	return serverapp.OnlineConfig{
		GuestCredentialTTL:     5 * time.Minute,
		OwnershipProofTTL:      5 * time.Minute,
		StreamMaxDuration:      5 * time.Minute,
		RulesWorkerEntry:       worker.entry,
		DeadlineSweepInterval:  time.Hour,
		DeadlineSweepBatch:     10,
		HealthCheckInterval:    time.Hour,
		HistoryPublishInterval: time.Hour,
		QueueSweepInterval:     time.Hour,
		QueueSweepBatch:        10,
	}
}

// The composed service narrows the accounts of the friend and the queue
// surface.
//
// The account that the cohort names is served, the account it does not name
// is refused, and a guest is never refused.
func TestPostgresTheCohortNarrowsTheComposedSurfaces(t *testing.T) {
	pool := testPool(t)
	if err := migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	worker := newFixtureRulesWorker(t, workerAnswers)
	clerk, key := cohortClerk(t)
	configuration := cohortOnlineConfig(worker)
	configuration.FriendEnabled = true
	configuration.QueueEnabled = true
	configuration.FriendCohort = cohort.Parse("user_allowed")
	configuration.QueueCohort = cohort.Parse("user_allowed")
	handler := cohortComposition(t, pool, worker, clerk, configuration)

	allowed := cohortSession(t, key, clerk.Issuer, "user_allowed")
	excluded := cohortSession(t, key, clerk.Issuer, "user_excluded")

	// The named account creates a friend link.
	created := cohortRequest(handler, http.MethodPost, "/v1/online/invitations", allowed,
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("the creation of a named account status=%d body=%s", created.Code, created.Body.String())
	}

	// The excluded account is refused, and it never reaches the service.
	refused := cohortRequest(handler, http.MethodPost, "/v1/online/invitations", excluded,
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if refused.Code != http.StatusForbidden {
		t.Fatalf("the creation of an excluded account status=%d body=%s", refused.Code, refused.Body.String())
	}
	if !strings.Contains(refused.Body.String(), "not_authorized") {
		t.Fatalf("the refusal does not name the refusal: %s", refused.Body.String())
	}
	var invitations int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM online_friend_invitations`).Scan(&invitations); err != nil {
		t.Fatal(err)
	}
	if invitations != 1 {
		t.Fatalf("the refused creation wrote %d invitations", invitations)
	}

	// A guest creates a friend link. The cohort never excludes a guest.
	guestLink := cohortRequest(handler, http.MethodPost, "/v1/online/invitations", "",
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if guestLink.Code != http.StatusCreated {
		t.Fatalf("the creation of a guest status=%d body=%s", guestLink.Code, guestLink.Body.String())
	}

	// The named account enters the public queue.
	entry := cohortRequest(handler, http.MethodPost, "/v1/online/queue/entries", allowed,
		`{"schemaVersion":2,"control":{"kind":"human"},"timeControl":{"startingTimeMs":300000,"incrementMs":0},"clientRequestId":"intent-0001"}`)
	if entry.Code != http.StatusCreated {
		t.Fatalf("the entry of a named account status=%d body=%s", entry.Code, entry.Body.String())
	}

	// The excluded account is refused by the queue as well.
	refusedEntry := cohortRequest(handler, http.MethodPost, "/v1/online/queue/entries", excluded,
		`{"schemaVersion":2,"control":{"kind":"human"},"timeControl":{"startingTimeMs":300000,"incrementMs":0},"clientRequestId":"intent-0002"}`)
	if refusedEntry.Code != http.StatusForbidden {
		t.Fatalf("the entry of an excluded account status=%d body=%s", refusedEntry.Code, refusedEntry.Body.String())
	}
	var entries int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM online_queue_entries`).Scan(&entries); err != nil {
		t.Fatal(err)
	}
	if entries != 1 {
		t.Fatalf("the refused entry wrote %d entries", entries)
	}
}

// The cohort keeps the guest path and the running match.
//
// A guest accepts an invitation that was issued while friend play was
// enabled, even after the switch closed, and an account that the cohort
// excludes keeps the match it already plays.
func TestPostgresTheCohortKeepsTheGuestPathAndTheRunningMatch(t *testing.T) {
	pool := testPool(t)
	if err := migrations.Apply(context.Background(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	worker := newFixtureRulesWorker(t, workerAnswers)
	clerk, key := cohortClerk(t)

	// The open surface issues the invitations and the match.
	open := cohortOnlineConfig(worker)
	open.FriendEnabled = true
	open.FriendCohort = cohort.Parse("")
	openHandler := cohortComposition(t, pool, worker, clerk, open)

	account := cohortSession(t, key, clerk.Issuer, "user_player")
	link := cohortRequest(openHandler, http.MethodPost, "/v1/online/invitations", account,
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if link.Code != http.StatusCreated {
		t.Fatalf("the creation of the link status=%d body=%s", link.Code, link.Body.String())
	}
	var answer struct {
		Invitation struct {
			InvitationID string `json:"invitationId"`
		} `json:"invitation"`
	}
	if err := json.Unmarshal(link.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	invitationID := answer.Invitation.InvitationID
	if invitationID == "" {
		t.Fatalf("the created link carries no identifier: %s", link.Body.String())
	}

	// The guest accepts the link, so a match exists.
	accepted := cohortRequest(openHandler, http.MethodPost, "/v1/online/invitations/"+invitationID+"/accept", "",
		`{"schemaVersion":2,"acceptanceKey":"cohort_acceptance_key_0001","control":{"kind":"human"}}`)
	if accepted.Code != http.StatusOK {
		t.Fatalf("the acceptance of the guest status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	var acceptance struct {
		Match struct {
			MatchID string `json:"matchId"`
		} `json:"match"`
	}
	if err := json.Unmarshal(accepted.Body.Bytes(), &acceptance); err != nil {
		t.Fatal(err)
	}
	matchID := acceptance.Match.MatchID
	if matchID == "" {
		t.Fatalf("the acceptance carries no match: %s", accepted.Body.String())
	}

	// A guest issues a second link while the surface is open. The closed
	// surface has to finish it.
	second := cohortRequest(openHandler, http.MethodPost, "/v1/online/invitations", "",
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if second.Code != http.StatusCreated {
		t.Fatalf("the creation of the second link status=%d body=%s", second.Code, second.Body.String())
	}
	var secondAnswer struct {
		Invitation struct {
			InvitationID string `json:"invitationId"`
		} `json:"invitation"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &secondAnswer); err != nil {
		t.Fatal(err)
	}
	secondInvitation := secondAnswer.Invitation.InvitationID
	if secondInvitation == "" {
		t.Fatalf("the created link carries no identifier: %s", second.Body.String())
	}

	// The closed surface keeps the invitation that was issued while it was
	// open, and a guest may still finish it.
	closed := cohortOnlineConfig(worker)
	closed.FriendEnabled = false
	closed.FriendCohort = cohort.Parse("user_other")
	closedHandler := cohortComposition(t, pool, worker, clerk, closed)

	finished := cohortRequest(closedHandler, http.MethodPost, "/v1/online/invitations/"+secondInvitation+"/accept", "",
		`{"schemaVersion":2,"acceptanceKey":"cohort_acceptance_key_0002","control":{"kind":"human"}}`)
	if finished.Code != http.StatusOK {
		t.Fatalf("the acceptance of the guest on the closed surface status=%d body=%s", finished.Code, finished.Body.String())
	}

	// The closed surface refuses a new creation, and the cohort does not
	// change that.
	refused := cohortRequest(closedHandler, http.MethodPost, "/v1/online/invitations", "",
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if refused.Code != http.StatusServiceUnavailable {
		t.Fatalf("the creation on a closed surface status=%d body=%s", refused.Code, refused.Body.String())
	}

	// The cohort narrows the account even on the closed surface.
	refusedAccount := cohortRequest(closedHandler, http.MethodPost, "/v1/online/invitations", account,
		`{"schemaVersion":2,"kind":"link","seat":"white","timeControl":{"startingTimeMs":300000,"incrementMs":0},"control":{"kind":"human"}}`)
	if refusedAccount.Code != http.StatusForbidden {
		t.Fatalf("the creation of an excluded account status=%d body=%s", refusedAccount.Code, refusedAccount.Body.String())
	}

	// The account that the cohort excludes keeps the match it already plays.
	live := cohortRequest(closedHandler, http.MethodGet, "/v1/online/matches/"+matchID, account, "")
	if live.Code != http.StatusOK {
		t.Fatalf("the live match of an excluded account status=%d body=%s", live.Code, live.Body.String())
	}
}
