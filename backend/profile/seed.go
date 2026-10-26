package profile

import (
	"context"
	"strings"

	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/jackc/pgx/v5"
)

// The bounds of one seed request. They keep a request from proposing an
// unbounded list of texts, and they keep the derived attempt list short
// enough that one seed stays a small, bounded transaction.
const (
	// maxSeedCandidates bounds how many candidate texts one request carries.
	maxSeedCandidates = 6
	// maxSeedCandidateLength bounds one candidate text before it is derived.
	maxSeedCandidateLength = 128
	// maxSeedBases bounds how many distinct derived names are tried as bases.
	maxSeedBases = 3
)

// DeriveUsername derives a choosable public name from arbitrary account text.
//
// The sign-in fields of an account are not public-name shaped: a full name
// carries spaces, and an email address carries dots and an @. The derivation
// keeps the readable characters, maps every run of separators onto one dash,
// trims separator ends, and fits the result into the public-name shape, so a
// derived name still reads as the text it came from.
//
// The service stays authoritative: the result is only a candidate, and
// NormalizeUsername has the final word. A text that yields no acceptable name
// is refused here, so the caller can propose the next one.
func DeriveUsername(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", false
	}
	var builder strings.Builder
	separator := false
	count := 0
	for _, symbol := range trimmed {
		kept := symbol >= 'a' && symbol <= 'z' ||
			symbol >= 'A' && symbol <= 'Z' ||
			symbol >= '0' && symbol <= '9' ||
			symbol == '_' || symbol == '-'
		if !kept {
			separator = true
			continue
		}
		if separator && count > 0 {
			builder.WriteByte('-')
			count++
			if count >= maxUsernameLength {
				break
			}
		}
		separator = false
		builder.WriteRune(symbol)
		count++
		if count >= maxUsernameLength {
			break
		}
	}
	name := strings.Trim(builder.String(), "-_")
	if _, _, err := NormalizeUsername(name); err != nil {
		return "", false
	}
	return name, true
}

// derivedBases reduces candidate texts to the ordered, distinct public names
// a seed tries as bases.
func derivedBases(candidates []string) []string {
	bases := make([]string, 0, maxSeedBases)
	seen := make(map[string]bool, len(candidates))
	for _, raw := range candidates {
		if len(bases) >= maxSeedBases {
			break
		}
		if len(raw) > maxSeedCandidateLength {
			runes := []rune(raw)
			// The bound exists so a hostile text cannot make the derivation
			// walk an unbounded string; the cut is at the bound, in runes.
			raw = string(runes[:maxSeedCandidateLength])
		}
		base, ok := DeriveUsername(raw)
		if !ok {
			continue
		}
		key := strings.ToLower(base)
		if seen[key] {
			continue
		}
		seen[key] = true
		bases = append(bases, base)
	}
	return bases
}

// seedNumbers are the numbered variants tried after each base name.
var seedNumbers = []string{"2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"}

// seedAttempts lists the distinct public names a seed tries, in order.
//
// The first attempts are the bases as derived; the later attempts add a
// numbered suffix, so a collision with another person's identical account
// name still ends in a distinct public name that reads as the same text.
func seedAttempts(bases []string) []string {
	attempts := make([]string, 0, len(bases)*(len(seedNumbers)+1))
	seen := make(map[string]bool, len(bases)*(len(seedNumbers)+1))
	add := func(name string) {
		if _, _, err := NormalizeUsername(name); err != nil {
			return
		}
		key := strings.ToLower(name)
		if seen[key] {
			return
		}
		seen[key] = true
		attempts = append(attempts, name)
	}
	for _, base := range bases {
		add(base)
	}
	for _, number := range seedNumbers {
		for _, base := range bases {
			// Derived bases are ASCII, so shortening one for its suffix is a
			// byte operation that cannot split a character.
			shortened := base
			for len(shortened)+len(number)+1 > maxUsernameLength {
				shortened = shortened[:len(shortened)-1]
			}
			shortened = strings.TrimRight(shortened, "-_")
			add(shortened + "-" + number)
		}
	}
	return attempts
}

// SeedUsername seeds the default public name of an account that has none.
//
// The account fields that name a person live in the browser and the verified
// session token does not carry them, so the browser proposes them as candidate
// texts and the service stays the only writer: every candidate is derived
// again under the account rules, the write runs under the account lock, and
// only a profile that still has no name is written. A profile that already has
// a name is answered unchanged, so the seed is idempotent and can never
// overwrite a deliberate choice of the owner.
//
// A name another profile already owns is not an error. The unique index
// arbitrates every attempt, so two concurrent seeds of the same name cannot
// both win, and the loser simply settles on the next variant of its own
// candidate. An account whose every variant collided keeps no name, and its
// owner can still choose one deliberately.
func (s *Service) SeedUsername(ctx context.Context, account onlineauth.Principal, candidates []string, origin string) (Profile, error) {
	bases := derivedBases(candidates)
	if len(bases) == 0 {
		// An account that proposed no usable text still gets a seamless
		// identity: the neutral base is numbered like any other candidate.
		bases = []string{"player"}
	}
	var seeded Profile
	err := s.withAccount(ctx, account, origin, func(ctx context.Context, tx pgx.Tx) error {
		// A deleted account keeps no public identity, and the seed never
		// revives one.
		closed, err := s.accountDeleted(ctx, tx, account.Subject)
		if err != nil {
			return err
		}
		if closed {
			return ErrProfileClosed
		}
		if err := s.ensureProfileRow(ctx, tx, account.Subject); err != nil {
			return err
		}
		row, err := s.readStoredProfile(ctx, tx, profileByAccount+" FOR UPDATE", account.Subject)
		if err != nil {
			return err
		}
		if row.Username != "" {
			seeded = row.profile()
			return nil
		}
		for _, candidate := range seedAttempts(bases) {
			key := strings.ToLower(candidate)
			if _, err = tx.Exec(ctx, `UPDATE online_public_profiles SET username=$1,username_key=$2,updated_at=clock_timestamp() WHERE profile_id=$3`,
				candidate, key, row.ProfileID); err != nil {
				if isUniqueViolation(err, uniqueUsernameIndex) {
					continue
				}
				return err
			}
			stored, err := s.readStoredProfile(ctx, tx, profileByAccount, account.Subject)
			if err != nil {
				return err
			}
			seeded = stored.profile()
			return nil
		}
		// Every variant collided with a name another profile owns. The
		// profile keeps no name; nothing about the account failed.
		seeded = row.profile()
		return nil
	})
	if err != nil {
		return Profile{}, err
	}
	return seeded, nil
}
