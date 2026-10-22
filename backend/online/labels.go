package online

import (
	"context"
	"fmt"
)

// resolveDeclaredControl resolves the publishable label of a declared
// control.
//
// The declared label of a model opponent is resolved before it is accepted, so
// the accepted event, the stored event and the returned receipt all carry the
// same publishable label. A private routing identity, a secret-bearing alias
// or a connection nickname is replaced by a neutral label before it is
// accepted, and it never reaches a durable row or a response body.
//
// The resolution is the same one the database applies on write, so the
// accepted value and the stored value are identical.
//
// A human control has no model label and is returned unchanged.
func (s *Service) resolveDeclaredControl(ctx context.Context, q Querier, matchID string, seat Seat, control SeatControl) (SeatControl, error) {
	if control.Kind == ControlHuman {
		return control, nil
	}
	if control.ModelLabel == nil {
		return SeatControl{}, fmt.Errorf("%w: the declared model label", ErrInvalidContract)
	}
	var (
		ownerKind string
		ownerID   string
	)
	if err := q.QueryRow(ctx, `SELECT owner_kind,owner_id FROM online_seats WHERE match_id=$1 AND seat=$2`, matchID, string(seat)).Scan(&ownerKind, &ownerID); err != nil {
		return SeatControl{}, err
	}
	var resolved *string
	if err := q.QueryRow(ctx, `SELECT online_resolve_public_model_label($1,$2,$3,$4)`, ownerKind, ownerID, string(control.Kind), *control.ModelLabel).Scan(&resolved); err != nil {
		return SeatControl{}, err
	}
	if resolved == nil || *resolved == "" {
		return SeatControl{}, fmt.Errorf("%w: the declared model label", ErrInvalidContract)
	}
	control.ModelLabel = resolved
	return control, nil
}
