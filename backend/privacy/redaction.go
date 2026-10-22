package privacy

import (
	"context"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5"
)

// redactSeatModelAliases redacts the personal model aliases of one removed
// seat.
//
// The published payloads of a match keep the declared model label of every
// seat, and the declared control timeline keeps the label of every control a
// seat ever declared. The label of a removed owner may be an alias the owner
// registered for their own model, and that alias is personal: a signed-out
// reader of the public replay must not see it after the owner was deleted.
//
// The redaction follows the policy of the seat anonymization: the label of the
// removed seat is resolved as the label of an anonymized owner, so an
// allowlisted public model name keeps its label and an alias the owner
// registered becomes the neutral label. The label of the opponent is never
// touched.
//
// The redaction is idempotent. A row that already carries the resolved label
// is not written again, so a repeated removal and the replay of the removal
// ledger after a restore change nothing.
//
// The redaction runs inside the transaction of the removal, next to the
// anonymization of the seat, so no observer ever sees a published payload that
// still names the alias of a removed owner.
func redactSeatModelAliases(ctx context.Context, tx pgx.Tx, matchID string, seat online.Seat) error {
	if _, err := tx.Exec(ctx, `
		UPDATE online_public_replays
		SET replay_json = online_redact_seat_model_aliases(replay_json, $2)
		WHERE match_id = $1 AND revoked_at IS NULL`, matchID, string(seat)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE online_public_projections
		SET projection_json = online_redact_seat_model_aliases(projection_json, $2)
		WHERE match_id = $1 AND revoked_at IS NULL`, matchID, string(seat)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE online_seat_control_timeline
		SET model_label = online_resolve_public_model_label('account', 'anonymized', control_kind, model_label)
		WHERE match_id = $1 AND seat = $2
		  AND model_label IS NOT NULL
		  AND model_label IS DISTINCT FROM online_resolve_public_model_label('account', 'anonymized', control_kind, model_label)`,
		matchID, string(seat)); err != nil {
		return err
	}
	return nil
}
