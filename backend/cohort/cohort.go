// Package cohort owns the optional account allowlist of an online surface.
//
// A cohort narrows **account** access to a surface. It is an allowlist: an
// empty cohort admits every signed-in account, and a cohort that names
// accounts admits exactly those accounts.
//
// A cohort never excludes a guest. The guest rule of the friend surface
// requires a guest to be able to create a friend link and to accept an
// invitation that was issued while friend play was enabled, so the decision
// of this package only ever narrows a participant of kind account. A guest
// identity is never compared with an identifier of the list, whatever the
// operator wrote into the setting.
//
// The package is a pure decision: it reads no configuration of its own and
// never fails. The server reads the setting once, when it boots, and the
// request path asks the cohort about the verified participant of a request.
package cohort

import (
	"context"
	"strings"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// Cohort is an optional allowlist of account identifiers.
//
// The zero value is the empty cohort, and the empty cohort admits every
// signed-in account.
type Cohort struct {
	accounts map[string]struct{}
	order    []string
}

// Parse reads the comma-separated account identifiers of a setting.
//
// The parser is well defined, so the same setting always describes the same
// cohort:
//
//   - every token is trimmed of the space around it,
//   - an empty token is ignored, so a trailing or a doubled comma changes
//     nothing,
//   - a repeated identifier is kept once, and the first occurrence wins,
//   - the identifiers keep the order of the setting, so the recorded cohort
//     reads in the order the operator wrote it.
//
// A token is only ever compared with an account identity. It never matches a
// guest, because the decision of the cohort ignores every participant that is
// not an account.
func Parse(value string) Cohort {
	accounts := make(map[string]struct{})
	order := make([]string, 0)
	for _, token := range strings.Split(value, ",") {
		token = strings.TrimSpace(token)
		if token == "" {
			continue
		}
		if _, seen := accounts[token]; seen {
			continue
		}
		accounts[token] = struct{}{}
		order = append(order, token)
	}
	return Cohort{accounts: accounts, order: order}
}

// Accounts returns the identifiers of the cohort in the order of the setting.
//
// The returned slice is a copy, so a caller cannot change the cohort of the
// process.
func (c Cohort) Accounts() []string {
	accounts := make([]string, len(c.order))
	copy(accounts, c.order)
	return accounts
}

// Empty reports whether the cohort names no account.
//
// An empty cohort admits every signed-in account, which is the default of the
// setting.
func (c Cohort) Empty() bool { return len(c.order) == 0 }

// Allows reports whether the participant may use the surface.
//
// Only an account is ever narrowed. A guest is always allowed, because a
// cohort of accounts must never exclude a guest, and the empty cohort allows
// every account.
func (c Cohort) Allows(participant online.ParticipantRef) bool {
	if participant.Kind != online.ParticipantAccount {
		return true
	}
	if len(c.accounts) == 0 {
		return true
	}
	_, allowed := c.accounts[participant.ID]
	return allowed
}

// AccountAllowed reports whether the participant may use the surface.
//
// It is the account authorization seam of the HTTP layer. The cohort is the
// configuration of the process, so the answer never fails and never reads
// anything.
func (c Cohort) AccountAllowed(_ context.Context, participant online.ParticipantRef) (bool, error) {
	return c.Allows(participant), nil
}
