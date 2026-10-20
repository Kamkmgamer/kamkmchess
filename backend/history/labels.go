package history

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
)

// secretLabelMarkers are the fragments of a value that must never appear in a
// public label.
//
// The screen is deliberately conservative. A label that looks like a key, a
// token, an endpoint or a credential is refused, because a public label is
// published to anybody who reads a replay.
var secretLabelMarkers = []string{
	"sk-", "sk_", "pk-", "pk_",
	"ghp_", "gho_", "ghu_", "ghs_", "github_pat_",
	"xoxb-", "xoxp-", "xoxa-", "xapp-",
	"ya29.", "-----begin", "bearer ", "bearer:",
	"api_key", "api-key", "apikey", "access_key", "secret_key", "private_key", "session_key",
	"password", "passwd", "credential", "authorization", "secret", "token",
}

// NormalizePublicLabel validates a public label an owner chose.
//
// The label is a chosen name, so it is bounded, free of control characters,
// and never an email address, an endpoint, or a URL. A label that could carry
// a secret is refused as well.
func NormalizePublicLabel(value string) (string, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", fmt.Errorf("%w: the label is empty", ErrInvalidLabel)
	}
	if len(trimmed) > 64 {
		return "", fmt.Errorf("%w: the label is longer than 64 characters", ErrInvalidLabel)
	}
	for _, r := range trimmed {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("%w: the label has a control character", ErrInvalidLabel)
		}
	}
	if strings.Contains(trimmed, "@") {
		return "", fmt.Errorf("%w: the label must not be an email address", ErrInvalidLabel)
	}
	if strings.Contains(trimmed, "://") {
		return "", fmt.Errorf("%w: the label must not be an endpoint", ErrInvalidLabel)
	}
	lower := strings.ToLower(trimmed)
	for _, marker := range secretLabelMarkers {
		if strings.Contains(lower, marker) {
			return "", fmt.Errorf("%w: the label must not carry a secret", ErrInvalidLabel)
		}
	}
	if looksLikeOpaqueSecret(trimmed) {
		return "", fmt.Errorf("%w: the label must not look like a credential", ErrInvalidLabel)
	}
	return trimmed, nil
}

// looksLikeOpaqueSecret reports whether a label looks like an opaque key.
//
// A long value without a space that mixes letters and digits is a credential
// shape, not a chosen name.
func looksLikeOpaqueSecret(value string) bool {
	if len(value) < 24 {
		return false
	}
	hasLetter := false
	hasDigit := false
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			hasLetter = true
		case r >= '0' && r <= '9':
			hasDigit = true
		case r == '-' || r == '_' || r == '.' || r == '/' || r == '+' || r == '=':
		default:
			return false
		}
	}
	return hasLetter && hasDigit
}

// newIdentifier returns a random, non-secret identifier for a stored row.
func newIdentifier(prefix string) (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("history: secure random source unavailable")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}
