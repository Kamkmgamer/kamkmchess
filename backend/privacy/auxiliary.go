package privacy

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// The auxiliary personal data of a removed subject.
//
// The friend surface and the queue surface keep their own records of the
// people they belong to: the invitation of an inviter with its public label
// and its recipient, the acceptance of an acceptor with its public label, the
// rematch offer of a proposer, and the queue entries of an owner with their
// declared model. A removed subject must not stay identifiable in any of them.
//
// The per match removal of a public replay is not one of these removals: it
// removes the replay of one match and keeps the participant, so it never
// touches this data.
//
// The sanitation is scoped to the subject. The invitations, acceptances,
// rematch offers and queue entries of the other participants are never
// touched.

// auxiliaryTablesPresent reports whether the friend and queue tables exist.
//
// A database that never had the friend or the queue schema has nothing to
// sanitize, so the removal is a no-op there.
func auxiliaryTablesPresent(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, table string) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=$1)`, table).Scan(&exists)
	if err != nil {
		return false, err
	}
	return exists, nil
}

// removeAuxiliaryPersonalData removes the personal data of the subject from
// the friend and the queue tables.
//
// The account scope lock is already held by the caller, so the rows of the
// subject are ordered against the allocation and the acceptance that could
// still name it.
func (s *Service) removeAuxiliaryPersonalData(ctx context.Context, tx pgx.Tx, subjectKind, rawID string) error {
	// The acceptances come first: an acceptance refers to its invitation, so
	// the unused acceptance has to be gone before the unused invitation.
	present, err := auxiliaryTablesPresent(ctx, tx, "online_invitation_acceptances")
	if err != nil {
		return err
	}
	if present {
		if err = s.removeInvitationAcceptances(ctx, tx, subjectKind, rawID); err != nil {
			return err
		}
	}
	present, err = auxiliaryTablesPresent(ctx, tx, "online_friend_invitations")
	if err != nil {
		return err
	}
	if present {
		if err = s.removeFriendInvitations(ctx, tx, subjectKind, rawID); err != nil {
			return err
		}
	}
	present, err = auxiliaryTablesPresent(ctx, tx, "online_rematch_offers")
	if err != nil {
		return err
	}
	if present {
		if err = s.removeRematchOffers(ctx, tx, subjectKind, rawID); err != nil {
			return err
		}
	}
	present, err = auxiliaryTablesPresent(ctx, tx, "online_queue_entries")
	if err != nil {
		return err
	}
	if present {
		if err = s.removeQueueEntries(ctx, tx, rawID); err != nil {
			return err
		}
	}
	return nil
}

// removeFriendInvitations removes the personal data of the subject from the
// friend invitations.
//
// An invitation that was never used is deleted: its preview would name the
// removed owner. An invitation that already produced a match keeps its row,
// because the match refers to it, and loses the identity of the inviter. A
// challenge that was addressed to the subject loses its recipient.
func (s *Service) removeFriendInvitations(ctx context.Context, tx pgx.Tx, subjectKind, rawID string) error {
	if _, err := tx.Exec(ctx, `
		DELETE FROM online_friend_invitations
		WHERE inviter_kind=$1 AND inviter_id=$2 AND match_id IS NULL`, subjectKind, rawID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE online_friend_invitations
		SET inviter_id='anonymized', inviter_public_label='Deleted player',
			inviter_model_label = CASE WHEN inviter_control_kind = 'human' THEN NULL ELSE 'Custom model' END,
			owner_token_hash=NULL
		WHERE inviter_kind=$1 AND inviter_id=$2 AND match_id IS NOT NULL`, subjectKind, rawID); err != nil {
		return err
	}
	if subjectKind != "account" {
		return nil
	}
	// A challenge addressed to the removed account loses its recipient. The
	// reserved anonymized value keeps the shape of the row: a challenge always
	// names a recipient, and the removed account is not a participant of the
	// invitation any more. The invitation of the other participant stays.
	if _, err := tx.Exec(ctx, `UPDATE online_friend_invitations SET recipient_account_id='anonymized' WHERE recipient_account_id=$1`, rawID); err != nil {
		return err
	}
	return nil
}

// removeInvitationAcceptances removes the personal data of the subject from
// the acceptances.
//
// An acceptance that never produced a match is deleted. An acceptance of a
// match keeps its row and loses the identity of the acceptor.
func (s *Service) removeInvitationAcceptances(ctx context.Context, tx pgx.Tx, subjectKind, rawID string) error {
	if _, err := tx.Exec(ctx, `
		DELETE FROM online_invitation_acceptances
		WHERE acceptor_kind=$1 AND acceptor_id=$2 AND match_id IS NULL`, subjectKind, rawID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE online_invitation_acceptances
		SET acceptor_id='anonymized', acceptor_public_label='Deleted player',
			model_label = CASE WHEN control_kind = 'human' THEN NULL ELSE 'Custom model' END,
			guest_id = CASE WHEN acceptor_kind = 'guest' THEN 'anonymized' ELSE guest_id END
		WHERE acceptor_kind=$1 AND acceptor_id=$2 AND match_id IS NOT NULL`, subjectKind, rawID); err != nil {
		return err
	}
	return nil
}

// removeRematchOffers removes the personal data of the subject from the
// rematch offers.
//
// The offer keeps its row, because the match it refers to keeps its own
// history, and loses the identity of the proposer and of the acceptor.
func (s *Service) removeRematchOffers(ctx context.Context, tx pgx.Tx, subjectKind, rawID string) error {
	if _, err := tx.Exec(ctx, `
		UPDATE online_rematch_offers
		SET proposer_id='anonymized', proposer_public_label='Deleted player'
		WHERE proposer_kind=$1 AND proposer_id=$2`, subjectKind, rawID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE online_rematch_offers SET accepted_by_id=NULL
		WHERE accepted_by_kind=$1 AND accepted_by_id=$2`, subjectKind, rawID); err != nil {
		return err
	}
	return nil
}

// removeQueueEntries removes the personal data of the subject from the queue.
//
// A waiting entry is deleted: it names nobody any more. An entry that already
// produced a match keeps its row, because the allocation refers to it, and
// loses the owner identifier. The public label of the participant in the
// allocation is redacted as well.
func (s *Service) removeQueueEntries(ctx context.Context, tx pgx.Tx, rawID string) error {
	// The entries of the subject are collected before they are redacted, so
	// the allocation of the subject can be found.
	rows, err := tx.Query(ctx, `SELECT entry_id FROM online_queue_entries WHERE owner_kind='account' AND owner_id=$1`, rawID)
	if err != nil {
		return err
	}
	entryIDs := make([]string, 0)
	for rows.Next() {
		var entryID string
		if err = rows.Scan(&entryID); err != nil {
			rows.Close()
			return err
		}
		entryIDs = append(entryIDs, entryID)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	if len(entryIDs) == 0 {
		return nil
	}
	// A waiting entry is deleted: it names nobody any more.
	if _, err = tx.Exec(ctx, `
		DELETE FROM online_queue_entries
		WHERE owner_kind='account' AND owner_id=$1 AND status <> 'assigned'`, rawID); err != nil {
		return err
	}
	// The allocation of the subject keeps its identity and loses the public
	// label and the declared model label of the removed participant. The
	// redaction runs before the entries are anonymized, because the guard of
	// the allocation finds the owner of the entry it refers to.
	present, err := auxiliaryTablesPresent(ctx, tx, "online_queue_allocations")
	if err != nil {
		return err
	}
	if present {
		if _, err = tx.Exec(ctx, `
			UPDATE online_queue_allocations a
			SET initiator_label='Deleted player',
				initiator_control_model_label = CASE WHEN a.initiator_control_kind = 'human' THEN NULL ELSE 'Custom model' END
			WHERE a.initiator_entry_id = ANY($1)
			  AND a.initiator_label <> 'Deleted player'`, entryIDs); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `
			UPDATE online_queue_allocations a
			SET opponent_label='Deleted player',
				opponent_control_model_label = CASE WHEN a.opponent_control_kind = 'human' THEN NULL ELSE 'Custom model' END
			WHERE a.opponent_entry_id = ANY($1)
			  AND a.opponent_label <> 'Deleted player'`, entryIDs); err != nil {
			return err
		}
	}
	// An assigned entry keeps its row and loses the owner identifier, the
	// declared model label and the client supplied idempotency key. The guard
	// of the queue entries accepts the redaction only with a recorded removal
	// request of the account.
	if _, err = tx.Exec(ctx, `
		UPDATE online_queue_entries
		SET owner_id='anonymized',
		seat_control_model_label = CASE WHEN seat_control_kind = 'human' THEN NULL ELSE 'Custom model' END,
		client_request_id=NULL, version=version+1
		WHERE owner_kind='account' AND owner_id=$1 AND status='assigned'`, rawID); err != nil {
		return err
	}
	return nil
}
