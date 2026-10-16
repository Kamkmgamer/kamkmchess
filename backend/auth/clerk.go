// Package auth verifies Clerk session tokens before they reach storage handlers.
package auth

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

var ErrUnauthorized = errors.New("unauthorized")

type Config struct {
	Issuer            string
	JWKSURL           string
	Audience          string
	AuthorizedParties []string
	AllowedOrigins    []string
	HTTPClient        *http.Client
	CacheTTL          time.Duration
	Now               func() time.Time
}

type Verifier struct {
	cfg                Config
	mu                 sync.Mutex
	keys               map[string]crypto.PublicKey
	keyAlgs            map[string]string
	validUntil         time.Time
	nextUnknownRefresh time.Time
}

type Claims struct {
	Subject         string
	SessionID       string
	Issuer          string
	AuthorizedParty string
	ExpiresAt       time.Time
}

type jwks struct {
	Keys []jwk `json:"keys"`
}
type jwk struct {
	Kty     string   `json:"kty"`
	Kid     string   `json:"kid"`
	Use     string   `json:"use"`
	Alg     string   `json:"alg"`
	KeyOps  []string `json:"key_ops"`
	Ext     bool     `json:"ext"`
	X5C     []string `json:"x5c"`
	X5T     string   `json:"x5t"`
	X5TS256 string   `json:"x5t#S256"`
	N       string   `json:"n"`
	E       string   `json:"e"`
	Crv     string   `json:"crv"`
	X       string   `json:"x"`
	Y       string   `json:"y"`
}

func NewVerifier(cfg Config) (*Verifier, error) {
	cfg.Issuer = strings.TrimRight(strings.TrimSpace(cfg.Issuer), "/")
	if cfg.Issuer == "" || cfg.JWKSURL == "" || len(cfg.AuthorizedParties) == 0 {
		return nil, errors.New("Clerk issuer, JWKS URL, and authorized parties are required")
	}
	issuerURL, issuerErr := url.Parse(cfg.Issuer)
	keyURL, keyErr := url.Parse(cfg.JWKSURL)
	if issuerErr != nil || keyErr != nil || issuerURL.Scheme != "https" || keyURL.Scheme != "https" || issuerURL.Host == "" || keyURL.Host == "" {
		return nil, errors.New("Clerk issuer and JWKS URL must use HTTPS")
	}
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 5 * time.Minute
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Verifier{cfg: cfg}, nil
}

func (v *Verifier) Verify(ctx context.Context, token, requestOrigin string) (Claims, error) {
	var zero Claims
	if len(token) > 16*1024 {
		return zero, ErrUnauthorized
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return zero, ErrUnauthorized
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return zero, ErrUnauthorized
	}
	var h struct{ Alg, Kid, Typ string }
	if !exactFieldNames(headerBytes, []string{"alg", "kid", "typ"}, false) || strictJSON(headerBytes, &h) != nil || h.Kid == "" || (h.Alg != "RS256" && h.Alg != "ES256") || (h.Typ != "" && !strings.EqualFold(h.Typ, "JWT")) {
		return zero, ErrUnauthorized
	}
	key, keyAlg, err := v.key(ctx, h.Kid)
	if err != nil || (keyAlg != "" && keyAlg != h.Alg) || !verifySignature(h.Alg, key, parts[0]+"."+parts[1], parts[2]) {
		return zero, ErrUnauthorized
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return zero, ErrUnauthorized
	}
	var c struct {
		Issuer          string          `json:"iss"`
		Subject         string          `json:"sub"`
		SessionID       string          `json:"sid"`
		Audience        json.RawMessage `json:"aud"`
		AuthorizedParty string          `json:"azp"`
		Expires         int64           `json:"exp"`
		NotBefore       int64           `json:"nbf"`
		IssuedAt        int64           `json:"iat"`
		TokenUse        string          `json:"token_use"`
		Status          string          `json:"sts"`
	}
	if err = decodeClaims(payload, &c); err != nil {
		return zero, ErrUnauthorized
	}
	now := v.cfg.Now()
	if c.Issuer != v.cfg.Issuer || c.Subject == "" || c.SessionID == "" || c.Expires == 0 || now.Unix() >= c.Expires || (c.NotBefore != 0 && now.Unix() < c.NotBefore) || (c.IssuedAt != 0 && c.IssuedAt > now.Add(time.Minute).Unix()) {
		return zero, ErrUnauthorized
	}
	if (c.TokenUse != "" && c.TokenUse != "session") || (c.Status != "" && c.Status != "active") {
		return zero, ErrUnauthorized
	}
	if !contains(v.cfg.AuthorizedParties, c.AuthorizedParty) {
		return zero, ErrUnauthorized
	}
	if v.cfg.Audience != "" && !audienceContains(c.Audience, v.cfg.Audience) {
		return zero, ErrUnauthorized
	}
	if requestOrigin != "" && !contains(v.cfg.AllowedOrigins, requestOrigin) {
		return zero, ErrUnauthorized
	}
	return Claims{Subject: c.Subject, SessionID: c.SessionID, Issuer: c.Issuer, AuthorizedParty: c.AuthorizedParty, ExpiresAt: time.Unix(c.Expires, 0)}, nil
}

// Clerk adds version, status, factor, and metadata claims to session tokens.
// Keep those claims forward-compatible while still rejecting duplicate JSON
// keys and decoding every security-relevant claim with its exact JSON type.
func decodeClaims(data []byte, target any) error {
	if err := uniqueJSON(data); err != nil {
		return err
	}
	if !exactFieldNames(data, []string{"iss", "sub", "sid", "aud", "azp", "exp", "nbf", "iat", "token_use", "sts"}, true) {
		return errors.New("invalid claim field names")
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	if err := dec.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

func exactFieldNames(data []byte, known []string, allowUnknown bool) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(data, &object) != nil || object == nil {
		return false
	}
	for key := range object {
		matched := false
		for _, name := range known {
			if strings.EqualFold(key, name) {
				if key != name {
					return false
				}
				matched = true
				break
			}
		}
		if !matched && !allowUnknown {
			return false
		}
	}
	return true
}

func (v *Verifier) key(ctx context.Context, kid string) (crypto.PublicKey, string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.cfg.Now()
	if now.Before(v.validUntil) {
		if k := v.keys[kid]; k != nil {
			return k, v.keyAlgs[kid], nil
		}
	}
	// Refreshes are rate-limited even when the key service is unavailable.
	if now.Before(v.nextUnknownRefresh) {
		return nil, "", ErrUnauthorized
	}
	v.nextUnknownRefresh = now.Add(10 * time.Second)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.cfg.JWKSURL, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := v.cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("JWKS status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || len(body) >= 1<<20 {
		return nil, "", errors.New("invalid JWKS response")
	}
	var set jwks
	if strictJSON(body, &set) != nil {
		return nil, "", errors.New("invalid JWKS")
	}
	keys := make(map[string]crypto.PublicKey, len(set.Keys))
	keyAlgs := make(map[string]string, len(set.Keys))
	for _, item := range set.Keys {
		if item.Kid == "" || (item.Use != "" && item.Use != "sig") {
			continue
		}
		if pub, e := publicKey(item); e == nil {
			keys[item.Kid] = pub
			keyAlgs[item.Kid] = item.Alg
		}
	}
	v.keys = keys
	v.keyAlgs = keyAlgs
	v.validUntil = now.Add(v.cfg.CacheTTL)
	if keys[kid] == nil {
		return nil, "", ErrUnauthorized
	}
	return keys[kid], keyAlgs[kid], nil
}

func publicKey(k jwk) (crypto.PublicKey, error) {
	switch k.Kty {
	case "RSA":
		n, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil {
			return nil, err
		}
		eb, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil || len(eb) == 0 || len(eb) > 4 {
			return nil, errors.New("invalid RSA exponent")
		}
		e := 0
		for _, b := range eb {
			e = e<<8 | int(b)
		}
		if e < 3 || e%2 == 0 {
			return nil, errors.New("invalid RSA exponent")
		}
		modulus := new(big.Int).SetBytes(n)
		if modulus.BitLen() < 2048 {
			return nil, errors.New("RSA key is too small")
		}
		return &rsa.PublicKey{N: modulus, E: e}, nil
	case "EC":
		if k.Crv != "P-256" {
			return nil, errors.New("unsupported curve")
		}
		xb, err := base64.RawURLEncoding.DecodeString(k.X)
		if err != nil {
			return nil, err
		}
		yb, err := base64.RawURLEncoding.DecodeString(k.Y)
		if err != nil {
			return nil, err
		}
		curve := elliptic.P256()
		x, y := new(big.Int).SetBytes(xb), new(big.Int).SetBytes(yb)
		if !curve.IsOnCurve(x, y) {
			return nil, errors.New("invalid EC point")
		}
		return &ecdsa.PublicKey{Curve: curve, X: x, Y: y}, nil
	default:
		return nil, errors.New("unsupported key type")
	}
}

func verifySignature(alg string, key crypto.PublicKey, input, encoded string) bool {
	sig, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return false
	}
	sum := sha256.Sum256([]byte(input))
	switch alg {
	case "RS256":
		k, ok := key.(*rsa.PublicKey)
		return ok && rsa.VerifyPKCS1v15(k, crypto.SHA256, sum[:], sig) == nil
	case "ES256":
		k, ok := key.(*ecdsa.PublicKey)
		return ok && len(sig) == 64 && ecdsa.Verify(k, sum[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
	default:
		return false
	}
}

func strictJSON(data []byte, target any) error {
	if err := uniqueJSON(data); err != nil {
		return err
	}
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

func uniqueJSON(data []byte) error {
	d := json.NewDecoder(strings.NewReader(string(data)))
	d.UseNumber()
	if err := consumeJSONValue(d); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return nil
}

func consumeJSONValue(d *json.Decoder) error {
	t, err := d.Token()
	if err != nil {
		return err
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]struct{}{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok {
				return errors.New("invalid object key")
			}
			if _, duplicate := seen[name]; duplicate {
				return errors.New("duplicate JSON key")
			}
			seen[name] = struct{}{}
			if err := consumeJSONValue(d); err != nil {
				return err
			}
		}
		_, err = d.Token()
		return err
	case '[':
		for d.More() {
			if err := consumeJSONValue(d); err != nil {
				return err
			}
		}
		_, err = d.Token()
		return err
	default:
		return errors.New("invalid JSON delimiter")
	}
}
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func audienceContains(raw json.RawMessage, expected string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == expected
	}
	var many []string
	if json.Unmarshal(raw, &many) == nil {
		return contains(many, expected)
	}
	return false
}

// Context helpers keep owner identity sourced only from a verified token.
type ownerContextKey struct{}

func WithOwner(ctx context.Context, owner string) context.Context {
	return context.WithValue(ctx, ownerContextKey{}, owner)
}
func Owner(ctx context.Context) (string, bool) {
	value, ok := ctx.Value(ownerContextKey{}).(string)
	return value, ok && value != ""
}
