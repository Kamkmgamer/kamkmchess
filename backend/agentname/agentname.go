// Package agentname reduces a self-reported agent name to the shape the
// service publishes: single spaces, no control or format characters, no @,
// no address-like text, and at most 40 runes. The MCP endpoint uses it for
// the seat label and the agent boards use it for the stored model name, so
// both stay one policy.
package agentname

import (
	"strings"
	"unicode"
)

// Clean keeps a self-reported name publishable: no control characters,
// no address-like text, and short enough for the seat label.
func Clean(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '@' {
			return -1
		}
		return r
	}, name)
	name = strings.ReplaceAll(name, "://", " ")
	return strings.TrimSpace(Clip(name, 40))
}

// Clip shortens value to its first limit runes.
func Clip(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
