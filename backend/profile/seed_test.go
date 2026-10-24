package profile

import (
	"strings"
	"testing"
)

func TestDeriveUsernameKeepsReadableAccountText(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"kamkmgamer", "kamkmgamer"},
		{"  Kamkmgamer  ", "Kamkmgamer"},
		{"Khalil Mageed", "Khalil-Mageed"},
		{"khalil  mageed", "khalil-mageed"},
		{"john.doe", "john-doe"},
		{"john.doe@example.com", "john-doe-example-com"},
		{"♟alicia", "alicia"},
		{"--magnus--", "magnus"},
		{"hikaru.nakamura", "hikaru-nakamura"},
	}
	for _, testCase := range cases {
		derived, ok := DeriveUsername(testCase.input)
		if !ok {
			t.Fatalf("DeriveUsername(%q) was refused", testCase.input)
		}
		if derived != testCase.want {
			t.Fatalf("DeriveUsername(%q) = %q, want %q", testCase.input, derived, testCase.want)
		}
	}
}

func TestDeriveUsernameRefusesUnusableAccountText(t *testing.T) {
	for _, input := range []string{
		"",
		"   ",
		"ab",
		"a",
		"guest",
		"Guest",
		"admin",
		"-_-",
		"♟♟♟",
	} {
		if derived, ok := DeriveUsername(input); ok {
			t.Fatalf("DeriveUsername(%q) = %q, want a refusal", input, derived)
		}
	}
}

func TestDeriveUsernameFitsThePublicNameShape(t *testing.T) {
	long := strings.Repeat("abcdefgh", 8)
	derived, ok := DeriveUsername(long)
	if !ok {
		t.Fatal("a long readable text must still derive a name")
	}
	if len(derived) > maxUsernameLength {
		t.Fatalf("derived name %q is longer than %d characters", derived, maxUsernameLength)
	}
	if _, _, err := NormalizeUsername(derived); err != nil {
		t.Fatalf("derived name %q is not choosable: %v", derived, err)
	}
}

func TestDerivedBasesKeepsOrderDistinctAndBounded(t *testing.T) {
	bases := derivedBases([]string{
		"Khalil Mageed",
		"khalil-mageed",
		"guest",
		"ab",
		"kamkmgamer",
		"extra-one",
		"extra-two",
	})
	want := []string{"Khalil-Mageed", "kamkmgamer", "extra-one"}
	if len(bases) != len(want) {
		t.Fatalf("derivedBases() = %v, want %v", bases, want)
	}
	for index, base := range want {
		if bases[index] != base {
			t.Fatalf("derivedBases()[%d] = %q, want %q", index, bases[index], base)
		}
	}
	if len(derivedBases(nil)) != 0 {
		t.Fatal("no candidates must derive no bases")
	}
}

func TestSeedAttemptsAreChoosableDistinctAndSuffixed(t *testing.T) {
	attempts := seedAttempts([]string{"khalil-mageed", "magnus"})
	if len(attempts) == 0 {
		t.Fatal("seedAttempts() returned no attempts")
	}
	seen := make(map[string]bool)
	for _, attempt := range attempts {
		if _, _, err := NormalizeUsername(attempt); err != nil {
			t.Fatalf("attempt %q is not choosable: %v", attempt, err)
		}
		if len(attempt) > maxUsernameLength {
			t.Fatalf("attempt %q is longer than %d characters", attempt, maxUsernameLength)
		}
		key := strings.ToLower(attempt)
		if seen[key] {
			t.Fatalf("attempt %q appears twice", attempt)
		}
		seen[key] = true
	}
	if !seen["khalil-mageed"] || !seen["magnus"] {
		t.Fatal("the bases as derived must be the first attempts")
	}
	if !seen["khalil-mageed-2"] || !seen["magnus-2"] {
		t.Fatal("a taken base must be retried with a numbered variant")
	}
	// A base at the length limit still yields a suffixed variant that fits.
	edge := strings.Repeat("a", maxUsernameLength)
	attempts = seedAttempts([]string{edge})
	found := false
	for _, attempt := range attempts {
		if strings.HasPrefix(attempt, "a") && strings.HasSuffix(attempt, "-2") {
			found = true
		}
	}
	if !found {
		t.Fatal("a full-length base must still produce a numbered variant")
	}
}
