package auth

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
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestClerkSessionVerificationAcceptsClerkClaimExtras(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	set := jwks{Keys: []jwk{{Kty: "RSA", Kid: "key-1", Use: "sig", Alg: "RS256", N: base64.RawURLEncoding.EncodeToString(priv.N.Bytes()), E: base64.RawURLEncoding.EncodeToString([]byte{1, 0, 1})}}}
	setBytes, _ := json.Marshal(set)
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://clerk.example/.well-known/jwks.json" {
			t.Fatalf("unexpected JWKS URL: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: ioNopCloser(strings.NewReader(string(setBytes))), Header: make(http.Header)}, nil
	})}
	now := time.Unix(1_800_000_000, 0)
	v, err := NewVerifier(Config{Issuer: "https://clerk.example", JWKSURL: "https://clerk.example/.well-known/jwks.json", Audience: "chess-api", AuthorizedParties: []string{"https://app.example"}, AllowedOrigins: []string{"https://app.example"}, HTTPClient: client, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	// Clerk's browser SDK includes client attestation and original issued-at
	// metadata in otherwise ordinary signed session-token headers.
	token := signedToken(t, priv, `{"alg":"RS256","kid":"key-1","typ":"JWT","cat":"cl_fixture","oiat":1800000000}`, fmt.Sprintf(`{"iss":"https://clerk.example","sub":"user_abc","sid":"sess_123","aud":["chess-api"],"azp":"https://app.example","exp":%d,"iat":%d,"v":2,"sts":"active","fva":[0,0],"metadata":{"tier":"free"}}`, now.Add(time.Hour).Unix(), now.Unix()))
	claims, err := v.Verify(context.Background(), token, "https://app.example")
	if err != nil {
		t.Fatalf("valid Clerk session with documented extra claims rejected: %v", err)
	}
	if claims.Subject != "user_abc" || claims.SessionID != "sess_123" {
		t.Fatalf("unexpected verified identity: %+v", claims)
	}
	if _, err := v.Verify(context.Background(), token, "https://evil.example"); err == nil {
		t.Fatal("token accepted from an unconfigured request origin")
	}
	wrongAudience := signedToken(t, priv, `{"alg":"RS256","kid":"key-1"}`, fmt.Sprintf(`{"iss":"https://clerk.example","sub":"user_abc","sid":"sess_123","aud":"another-api","azp":"https://app.example","exp":%d}`, now.Add(time.Hour).Unix()))
	if _, err := v.Verify(context.Background(), wrongAudience, "https://app.example"); err == nil {
		t.Fatal("token with wrong audience accepted")
	}
	expired := signedToken(t, priv, `{"alg":"RS256","kid":"key-1"}`, fmt.Sprintf(`{"iss":"https://clerk.example","sub":"user_abc","sid":"sess_123","aud":"chess-api","azp":"https://app.example","exp":%d}`, now.Add(-time.Second).Unix()))
	if _, err := v.Verify(context.Background(), expired, "https://app.example"); err == nil {
		t.Fatal("expired token accepted")
	}
}

func TestClerkSessionVerificationRejectsWrongIdentityAndDuplicateClaims(t *testing.T) {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	set := jwks{Keys: []jwk{{Kty: "RSA", Kid: "key-1", Use: "sig", Alg: "RS256", N: base64.RawURLEncoding.EncodeToString(priv.N.Bytes()), E: base64.RawURLEncoding.EncodeToString([]byte{1, 0, 1})}}}
	setBytes, _ := json.Marshal(set)
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: ioNopCloser(strings.NewReader(string(setBytes))), Header: make(http.Header)}, nil
	})}
	now := time.Unix(1_800_000_000, 0)
	v, err := NewVerifier(Config{Issuer: "https://clerk.example", JWKSURL: "https://clerk.example/jwks", Audience: "chess-api", AuthorizedParties: []string{"https://app.example"}, AllowedOrigins: []string{"https://app.example"}, HTTPClient: client, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf(`"iss":"https://clerk.example","sub":"user_abc","sid":"sess_123","aud":"chess-api","azp":"https://app.example","exp":%d`, now.Add(time.Hour).Unix())
	for name, payload := range map[string]string{
		"wrong party":       `{"` + base + `}`, // replaced below with valid JSON mutation
		"pending session":   fmt.Sprintf(`{"iss":"https://clerk.example","sub":"user_abc","sid":"sess_123","aud":"chess-api","azp":"https://app.example","exp":%d,"sts":"pending"}`, now.Add(time.Hour).Unix()),
		"no session id":     fmt.Sprintf(`{"iss":"https://clerk.example","sub":"user_abc","aud":"chess-api","azp":"https://app.example","exp":%d}`, now.Add(time.Hour).Unix()),
		"duplicate subject": fmt.Sprintf(`{"iss":"https://clerk.example","sub":"user_abc","sub":"attacker","sid":"sess_123","aud":"chess-api","azp":"https://app.example","exp":%d}`, now.Add(time.Hour).Unix()),
		"uppercase issuer":  fmt.Sprintf(`{"ISS":"https://clerk.example","sub":"user_abc","sid":"sess_123","aud":"chess-api","azp":"https://app.example","exp":%d}`, now.Add(time.Hour).Unix()),
	} {
		if name == "wrong party" {
			payload = fmt.Sprintf(`{"iss":"https://clerk.example","sub":"user_abc","sid":"sess_123","aud":"chess-api","azp":"https://evil.example","exp":%d}`, now.Add(time.Hour).Unix())
		}
		t.Run(name, func(t *testing.T) {
			token := signedToken(t, priv, `{"alg":"RS256","kid":"key-1"}`, payload)
			if _, err := v.Verify(context.Background(), token, "https://app.example"); err == nil {
				t.Fatal("invalid token accepted")
			}
		})
	}
	upperHeader := signedToken(t, priv, `{"ALG":"RS256","kid":"key-1"}`, fmt.Sprintf(`{"iss":"https://clerk.example","sub":"user_abc","sid":"sess_123","aud":"chess-api","azp":"https://app.example","exp":%d}`, now.Add(time.Hour).Unix()))
	if _, err := v.Verify(context.Background(), upperHeader, "https://app.example"); err == nil {
		t.Fatal("case-variant JWT algorithm field accepted")
	}
	for _, header := range []string{
		`{"alg":"RS256","kid":"key-1","cat":12}`,
		`{"alg":"RS256","kid":"key-1","oiat":"1800000000"}`,
		`{"alg":"RS256","kid":"key-1","cat":"first","cat":"second"}`,
		`{"alg":"RS256","kid":"key-1","CAT":"cl_fixture"}`,
		`{"alg":"RS256","kid":"key-1","crit":["unhandled"]}`,
		`{"alg":"RS256","kid":"key-1","jku":"https://attacker.example/keys"}`,
	} {
		token := signedToken(t, priv, header, `{`+base+`}`)
		if _, err := v.Verify(context.Background(), token, "https://app.example"); err == nil {
			t.Fatalf("unsupported or malformed header accepted: %s", header)
		}
	}
}

func TestUnknownJWKIDRefreshIsRateLimited(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keys := jwks{Keys: []jwk{{Kty: "RSA", Kid: "known-key", Use: "sig", Alg: "RS256", N: base64.RawURLEncoding.EncodeToString(key.N.Bytes()), E: base64.RawURLEncoding.EncodeToString([]byte{1, 0, 1})}}}
	raw, _ := json.Marshal(keys)
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 200, Body: ioNopCloser(strings.NewReader(string(raw))), Header: make(http.Header)}, nil
	})}
	v, err := NewVerifier(Config{Issuer: "https://clerk.example", JWKSURL: "https://clerk.example/jwks", AuthorizedParties: []string{"https://app.example"}, HTTPClient: client, Now: func() time.Time { return time.Unix(1_800_000_000, 0) }})
	if err != nil {
		t.Fatal(err)
	}
	unknown := signedToken(t, key, `{"alg":"RS256","kid":"unknown-key"}`, `{"iss":"https://clerk.example","sub":"user_abc","sid":"session","azp":"https://app.example","exp":1900000000}`)
	for i := 0; i < 2; i++ {
		if _, err := v.Verify(context.Background(), unknown, ""); err == nil {
			t.Fatal("token with unknown kid accepted")
		}
	}
	if calls != 1 {
		t.Fatalf("unknown kid triggered %d JWKS fetches, want one bounded refresh", calls)
	}
}

func TestUnavailableJWKSRefreshIsRateLimited(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 503, Body: ioNopCloser(strings.NewReader("unavailable")), Header: make(http.Header)}, nil
	})}
	v, err := NewVerifier(Config{Issuer: "https://clerk.example", JWKSURL: "https://clerk.example/jwks", AuthorizedParties: []string{"https://app.example"}, HTTPClient: client, Now: func() time.Time { return time.Unix(1_800_000_000, 0) }})
	if err != nil {
		t.Fatal(err)
	}
	token := signedToken(t, key, `{"alg":"RS256","kid":"unknown"}`, `{"iss":"https://clerk.example","sub":"user_abc","sid":"session","azp":"https://app.example","exp":1900000000}`)
	for i := 0; i < 2; i++ {
		if _, err := v.Verify(context.Background(), token, ""); err == nil {
			t.Fatal("token accepted without JWKS verification")
		}
	}
	if calls != 1 {
		t.Fatalf("unavailable JWKS triggered %d fetches, want bounded single attempt", calls)
	}
}

func signedToken(t *testing.T, key *rsa.PrivateKey, header, payload string) string {
	t.Helper()
	enc := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	input := enc(header) + "." + enc(payload)
	sum := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

type nopCloser struct{ *strings.Reader }

func (n nopCloser) Close() error              { return nil }
func ioNopCloser(r *strings.Reader) nopCloser { return nopCloser{r} }
