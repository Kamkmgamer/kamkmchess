package invite

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PublicLabelResolver returns the public label of an account.
//
// The resolver is a read-only projection read. It never writes a profile row
// and never publishes the account identifier.
type PublicLabelResolver interface {
	PublicLabel(ctx context.Context, accountID string) (string, error)
}

// AccountLabelResolver reads the chosen public name of an account.
//
// A signed-in account without a chosen name has no published name. Its
// participant label is the neutral Player label, and a guest keeps the Guest
// label.
type AccountLabelResolver struct {
	db *pgxpool.Pool
}

// NewAccountLabelResolver binds the resolver to a pool.
func NewAccountLabelResolver(db *pgxpool.Pool) *AccountLabelResolver {
	return &AccountLabelResolver{db: db}
}

// PublicLabel returns the public label of an account.
func (r *AccountLabelResolver) PublicLabel(ctx context.Context, accountID string) (string, error) {
	if r == nil || r.db == nil {
		return "Player", nil
	}
	var username *string
	if err := r.db.QueryRow(ctx, `SELECT username FROM online_public_profiles WHERE account_id=$1`, accountID).Scan(&username); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "Player", nil
		}
		return "", err
	}
	if username == nil || *username == "" {
		return "Player", nil
	}
	return *username, nil
}

// AccountIDByUsername returns the account of the owner of a public name.
//
// The comparison is case-insensitive, so the lookup a named challenge needs
// finds the owner whichever spelling the challenger used.
//
// The account identifier is an authorization identity. It stays inside the
// service: it is never published, it never reaches an answer and it never
// crosses the boundary of the public request.
func (r *AccountLabelResolver) AccountIDByUsername(ctx context.Context, username string) (string, error) {
	key := strings.ToLower(strings.TrimSpace(username))
	if r == nil || r.db == nil || key == "" {
		return "", ErrRecipientNotFound
	}
	var accountID string
	if err := r.db.QueryRow(ctx, `SELECT account_id FROM online_public_profiles WHERE username_key=$1`, key).Scan(&accountID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrRecipientNotFound
		}
		return "", err
	}
	if strings.TrimSpace(accountID) == "" {
		return "", ErrRecipientNotFound
	}
	return accountID, nil
}
