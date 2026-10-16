package httpapi

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
)

type jwksTransport func(*http.Request) (*http.Response, error)

func (f jwksTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestAuthenticatedHandlerRejectsMalformedAndSecretBodies(t *testing.T) {
	key, handler := validationHandler(t)
	token := sessionToken(t, key, "user_example", "https://app.example")
	cases := map[string]string{
		"duplicate fields":   `{"gameId":"one","gameId":"two","checkpoint":{}}`,
		"unknown API secret": `{"gameId":"g","apiKey":"canary-secret","checkpoint":{}}`,
		"case variant":       `{"GameID":"g","checkpoint":{}}`,
		"nested duplicate":   `{"gameId":"g","checkpoint":{"gameId":"one","gameId":"two"}}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/v1/games", strings.NewReader(body))
			request.Header.Set("Origin", "https://app.example")
			request.Header.Set("Authorization", "Bearer "+token)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			if strings.Contains(response.Body.String(), "canary-secret") {
				t.Fatal("rejected request echoed a secret")
			}
		})
	}
}

func TestAuthenticatedHandlerRejectsRequestsWithoutVerifiedSessionOrAllowedOrigin(t *testing.T) {
	key, handler := validationHandler(t)
	for name, tc := range map[string]struct{ token, origin string }{
		"no token":        {"", "https://app.example"},
		"malformed token": {"not-a-jwt", "https://app.example"},
		"foreign origin":  {sessionToken(t, key, "user_example", "https://app.example"), "https://evil.example"},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/v1/games", nil)
			request.Header.Set("Origin", tc.origin)
			if tc.token != "" {
				request.Header.Set("Authorization", "Bearer "+tc.token)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
		})
	}
}

func TestAuthenticatedHandlerRejectsMalformedCompleteArchiveBatchBeforeStore(t *testing.T) {
	key, handler := validationHandler(t)
	checkpoint := `{"schemaVersion":1,"gameId":"g","namespace":{"kind":"account","accountId":"user_example"},"revision":2,"ownershipEpoch":1,"segmentId":"seg-1","positionRevision":1,"requestGeneration":0,"analysisGeneration":0,"updatedAtMs":1000,"rules":{"variant":"orthodox","startingFen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","currentFen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","sideToMove":"white","castlingRights":"KQkq","enPassantSquare":null,"halfmoveClock":"0","fullmoveNumber":"1","repetitionLedger":{"version":1,"positions":[{"identity":"initial-position","occurrences":"1"}]},"moves":[]},"history":{"currentSegmentId":"seg-1","segments":[{"segmentId":"seg-1","providerId":"openai","modelRoutingId":"model-id","connectionRevision":1,"startedAtMs":1000,"messageIds":[]}],"messages":[]},"clocks":{"schemaVersion":1,"timeControl":{"startingTimeMs":60000,"incrementMs":0},"banksAtAnchor":{"whiteMs":60000,"blackMs":60000},"activeSide":null,"anchor":null,"lastReconciledAtMs":1000},"budgets":{"formattingCorrectionsRemaining":2,"illegalMoveAttemptsRemaining":{"white":3,"black":3},"manualRetriesBySide":{"white":0,"black":0}},"selections":{"players":{"white":{"kind":"human"},"black":{"kind":"model","providerId":"openai","connectionId":"conn-1","configurationRevision":1,"modelRoutingId":"model-id","protocol":"responses","diagnostic":"passed-current-session"}}},"archive":{"egressStatus":"eligible","currentLine":{"lineId":"line-1","eventIds":[]},"discardedLines":[]},"result":{"kind":"unresolved"},"practice":{"mode":"ordinary","scored":true,"sourceGameId":null,"sourcePositionFen":null,"originalResult":null},"extensions":{}}`
	batch := `{"format":"kamkmchess.cloud-archive-batch","schemaVersion":1,"gameId":"other","baseRevision":1,"baseOwnershipEpoch":1,"checkpointRevision":2,"eventsAfterSequence":null,"eventsThroughSequence":null,"chunksAfterSequence":null,"chunksThroughSequence":null,"events":[],"chunks":[]}`
	body := fmt.Sprintf(`{"operationId":"op-1","expectedRevision":1,"expectedEpoch":1,"checkpoint":%s,"archiveBatch":%s}`, checkpoint, batch)
	request := httptest.NewRequest(http.MethodPost, "/v1/games/g/commit", strings.NewReader(body))
	request.Header.Set("Origin", "https://app.example")
	request.Header.Set("Authorization", "Bearer "+sessionToken(t, key, "user_example", "https://app.example"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
}

func validationHandler(t *testing.T) (*rsa.PrivateKey, http.Handler) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := map[string]any{"keys": []any{map[string]string{"kty": "RSA", "kid": "test-key", "use": "sig", "alg": "RS256", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString([]byte{1, 0, 1})}}}
	raw, _ := json.Marshal(jwks)
	client := &http.Client{Transport: jwksTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(string(raw))), Header: make(http.Header)}, nil
	})}
	verifier, err := auth.NewVerifier(auth.Config{Issuer: "https://clerk.example", JWKSURL: "https://clerk.example/jwks", AuthorizedParties: []string{"https://app.example"}, AllowedOrigins: []string{"https://app.example"}, HTTPClient: client, Now: func() time.Time { return time.Unix(1_800_000_000, 0) }})
	if err != nil {
		t.Fatal(err)
	}
	return key, NewAuthenticated(nil, verifier)
}

func sessionToken(t *testing.T, key *rsa.PrivateKey, subject, party string) string {
	t.Helper()
	encode := func(data []byte) string { return base64.RawURLEncoding.EncodeToString(data) }
	header := encode([]byte(`{"alg":"RS256","kid":"test-key","typ":"JWT"}`))
	payload := encode([]byte(fmt.Sprintf(`{"iss":"https://clerk.example","sub":%q,"sid":"session-1","azp":%q,"exp":%d,"sts":"active","v":2,"metadata":{"fixture":true}}`, subject, party, time.Unix(1_800_003_600, 0).Unix())))
	input := header + "." + payload
	digest := sha256.Sum256([]byte(input))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + encode(signature)
}
