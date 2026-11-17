package agentname

import "testing"

func TestCleanKeepsSelfReportedNamesPublishable(t *testing.T) {
	for in, want := range map[string]string{
		"  Claude   Opus 5.5 ":  "Claude Opus 5.5",
		"me@example.com":        "meexample.com",
		"see https://x.example": "see https x.example",
		"bidi‮evil\x07":         "bidievil",
		"a very long model name that goes on and on forever": "a very long model name that goes on and",
	} {
		if got := Clean(in); got != want {
			t.Errorf("Clean(%q) = %q, want %q", in, got, want)
		}
	}
}
