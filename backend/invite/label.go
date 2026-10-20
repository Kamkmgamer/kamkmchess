package invite

import (
	"context"
	"errors"

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
