package privacy

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/locks"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Options configures the privacy service.
type Options struct {
	// Now overrides the clock for tests.
	Now func() time.Time
	// LiveRemovalDelay is the target of the live removal.
	LiveRemovalDelay time.Duration
	// RecoverySanitizeDelay is the target of the recovery copy sanitation.
	RecoverySanitizeDelay time.Duration
	// FencePath is the parent directory of the durable restore fence.
	//
	// The fence lives outside the restored database, so it survives the
	// schema replacement of a restore and a crash of the restore process. The
	// service refuses to serve while the fence is open.
	//
	// The path is the *parent* directory that the operator prepares: the
	// lifecycle owns a lock directory inside it, and the operator never has to
	// prepare the lock directory itself.
	FencePath string
}

// Service removes the data of an account or of a guest.
//
// The service writes only the removal tables, the deletion markers and the
// anonymized rows of the shared tables. It never rewrites a received result,
// never moves a seat to another participant, and never deletes an accepted
// move.
type Service struct {
	db         *pgxpool.Pool
	authorizer *onlineauth.Service
	options    Options
}

// Open binds the privacy service to a pool. It does not mutate the schema.
func Open(_ context.Context, db *pgxpool.Pool, authorizer *onlineauth.Service, options Options) (*Service, error) {
	if db == nil {
		return nil, errors.New("privacy: nil database pool")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.LiveRemovalDelay <= 0 {
		options.LiveRemovalDelay = DefaultLiveRemovalDelay
	}
	if options.RecoverySanitizeDelay <= 0 {
		options.RecoverySanitizeDelay = DefaultRecoverySanitizeDelay
	}
	return &Service{db: db, authorizer: authorizer, options: options}, nil
}

func (s *Service) now() time.Time { return s.options.Now().UTC() }

// DeleteAccount removes the account's own public identity and its
// service-held private owner data, and anonymizes the shared games.
//
// The account is fenced first: its sessions are revoked inside the same
// transaction that sanitizes the snapshots, so a late command of the deleted
// account can neither start nor finish after the deletion.
//
// The shared games are kept. The deleted participant appears as
// "Deleted player" in the opponent's history and on the public replay.
func (s *Service) DeleteAccount(ctx context.Context, account onlineauth.Principal, origin string) (Report, error) {
	if account.Kind != online.ParticipantAccount || account.Subject == "" {
		return Report{}, ErrNotAuthorized
	}
	return s.remove(ctx, account, origin, ScopeAccountDeletion)
}

// RemoveAccount erases the shared replays of the account.
//
// The request is explicit and verified: the verified account session proves
// the ownership of the subject. The shared replays leave both online
// histories and the public URLs. The opponent keeps the anonymous result
// aggregate of the erased games.
func (s *Service) RemoveAccount(ctx context.Context, account onlineauth.Principal, origin string) (Report, error) {
	if account.Kind != online.ParticipantAccount || account.Subject == "" {
		return Report{}, ErrNotAuthorized
	}
	return s.remove(ctx, account, origin, ScopeExplicitRemoval)
}

// RemoveGuest erases the shared replays of a guest.
//
// The guest proves the ownership of its seat with the retained seat
// credential. The request never names an account, and a guest credential
// never acts for an account.
func (s *Service) RemoveGuest(ctx context.Context, guest onlineauth.Principal, origin string) (Report, error) {
	if guest.Kind != online.ParticipantGuest || guest.Subject == "" {
		return Report{}, ErrNotAuthorized
	}
	return s.remove(ctx, guest, origin, ScopeExplicitRemoval)
}

// remove runs one removal flow.
//
// The whole flow is one transaction. The ownership is checked inside it, the
// account is fenced inside it, and the snapshots are sanitized inside it, so
// no observer can see a half-removed account and no late write can slip
// between the fence and the sanitation.
func (s *Service) remove(ctx context.Context, principal onlineauth.Principal, origin, scope string) (Report, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Report{}, err
	}
	defer tx.Rollback(ctx)
	if principal.Kind == online.ParticipantAccount {
		// The account scope lock orders the removal against the trusted
		// allocation of a seat for the same participant. It is the shared
		// lock of the online service, so an allocation and a removal of one
		// participant are ordered instead of racing.
		if err = locks.LockAccountScope(ctx, tx, locks.AccountScope(string(principal.Participant.Kind), principal.Participant.ID)); err != nil {
			return Report{}, err
		}
		if s.authorizer == nil {
			return Report{}, errors.New("privacy: no account authorizer is configured")
		}
		// The session is checked before the fence, so a revoked session cannot
		// ask for a removal it does not own.
		if err = s.authorizer.AuthorizeAccount(ctx, tx, principal, origin); err != nil {
			return Report{}, err
		}
		// The fence comes before the sanitation. Every later command of this
		// account is refused, and the account lock keeps a command that is
		// already running ordered against this transaction.
		if _, err = tx.Exec(ctx, `INSERT INTO online_session_revocations(subject_id,session_id,revoked_at,reason) VALUES($1,'*',clock_timestamp(),$2) ON CONFLICT (subject_id,session_id) DO NOTHING`,
			principal.Subject, revocationReason(scope)); err != nil {
			return Report{}, err
		}
	} else {
		if s.authorizer == nil {
			return Report{}, errors.New("privacy: no account authorizer is configured")
		}
		// The guest scope lock orders the removal against the allocation of a
		// seat for the same guest.
		if err = locks.LockAccountScope(ctx, tx, locks.AccountScope(string(principal.Participant.Kind), principal.Participant.ID)); err != nil {
			return Report{}, err
		}
		// The guest proves the ownership of its seat with the live seat
		// credential. The credential is re-checked inside the transaction.
		ctx = onlineauth.WithPrincipal(ctx, principal)
		if err = s.authorizer.AuthorizeSeat(ctx, tx, principal.MatchID, principal.Participant, principal.Seat); err != nil {
			return Report{}, err
		}
	}
	report, err := s.applyRemoval(ctx, tx, principal, scope)
	if err != nil {
		return Report{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Report{}, err
	}
	return report, nil
}

// applyRemoval performs the removal of one subject inside the transaction.
func (s *Service) applyRemoval(ctx context.Context, tx pgx.Tx, principal onlineauth.Principal, scope string) (Report, error) {
	subjectKind := string(principal.Participant.Kind)
	subjectID := principal.Participant.ID
	reference := subject.Reference(subjectID)
	now := s.now()
	request, err := s.ensureRequest(ctx, tx, subjectKind, reference, scope, now)
	if err != nil {
		return Report{}, err
	}
	matches, err := s.subjectMatches(ctx, tx, subjectKind, reference)
	if err != nil {
		return Report{}, err
	}
	report := Report{
		SchemaVersion:         SchemaVersion,
		RemovalID:             request.RemovalID,
		Scope:                 scope,
		Status:                request.Status,
		VerifiedAt:            request.VerifiedAt.UTC(),
		LiveDeleteDueAt:       request.LiveDeleteDueAt.UTC(),
		RecoverySanitizeDueAt: request.RecoverySanitizeDueAt.UTC(),
	}
	for _, match := range matches {
		// The match row lock orders the removal against the publication of
		// the replay of that match. The projection takes the same lock, so
		// the two are never interleaved: either the removal is recorded
		// first and the projection refuses to publish, or the projection
		// publishes first and the removal revokes or anonymizes it.
		//
		// The matches are locked in ascending identifier order, which is the
		// order the projection locks them in as well, so the two paths
		// cannot deadlock.
		if _, err = tx.Exec(ctx, `SELECT match_id FROM online_matches WHERE match_id=$1 FOR UPDATE`, match.MatchID); err != nil {
			return Report{}, err
		}
		if err = s.applyMatchRemoval(ctx, tx, request.RemovalID, subjectKind, reference, scope, match); err != nil {
			return Report{}, err
		}
		if scope == ScopeExplicitRemoval {
			report.RemovedMatches++
		} else {
			report.AnonymizedMatches++
		}
	}
	if scope == ScopeExplicitRemoval {
		// The shared games leave both histories. The aggregate totals of the
		// opponent are kept: only the anonymous result aggregate remains.
		if _, err = tx.Exec(ctx, `DELETE FROM online_profile_results WHERE match_id = ANY($1)`, matchIDs(matches)); err != nil {
			return Report{}, err
		}
	} else {
		// The deleted account keeps no public history of its own.
		if _, err = tx.Exec(ctx, `DELETE FROM online_profile_results WHERE profile_id = (SELECT profile_id FROM online_public_profiles WHERE `+subject.SQLReference("account_id")+` = $1)`, reference); err != nil {
			return Report{}, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM online_profile_result_totals WHERE profile_id = (SELECT profile_id FROM online_public_profiles WHERE `+subject.SQLReference("account_id")+` = $1)`, reference); err != nil {
			return Report{}, err
		}
	}
	if err = s.removePrivateOwnerData(ctx, tx, subjectKind, reference, subjectID, scope); err != nil {
		return Report{}, err
	}
	// The subject level record states that the subject itself was removed,
	// whatever it played and whatever private data it held. It is the record
	// that survives a restore of an older backup, where the deletion table of
	// the subject is absent.
	subjectRecordID, err := newIdentifier("rs_")
	if err != nil {
		return Report{}, err
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO online_removal_subjects(subject_id,removal_id,subject_kind,subject_ref,scope,removed_at)
		VALUES($1,$2,$3,$4,$5,$6)
		ON CONFLICT (subject_kind, subject_ref, scope) DO NOTHING`,
		subjectRecordID, request.RemovalID, subjectKind, reference, scope, now); err != nil {
		return Report{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE online_removal_requests SET status='applied', applied_at=$1, live_deleted_at=$1, removed_match_count=$2, anonymized_match_count=$3 WHERE removal_id=$4`,
		now, report.RemovedMatches, report.AnonymizedMatches, report.RemovalID); err != nil {
		return Report{}, err
	}
	report.Status = "applied"
	report.LiveDeletedAt = now
	return report, nil
}

// removalRequest is the stored removal request.
type removalRequest struct {
	RemovalID             string
	Status                string
	VerifiedAt            time.Time
	LiveDeleteDueAt       time.Time
	RecoverySanitizeDueAt time.Time
}

// ensureRequest returns the removal request of the subject, creating it when
// it is missing.
//
// The subject is named by its one-way reference, so the request table never
// retains the identifier of a removed subject.
//
// The unique index of the request table is what makes a repeated request
// idempotent: the second request of the same subject and scope finds the
// first one.
func (s *Service) ensureRequest(ctx context.Context, tx pgx.Tx, subjectKind, reference, scope string, now time.Time) (removalRequest, error) {
	removalID, err := newIdentifier("rm_")
	if err != nil {
		return removalRequest{}, err
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO online_removal_requests(removal_id,subject_kind,subject_id,scope,status,requested_at,verified_at,live_delete_due_at,recovery_sanitize_due_at)
		VALUES($1,$2,$3,$4,'verified',$5,$5,$6,$7)
		ON CONFLICT (subject_kind, subject_id, scope) DO NOTHING`,
		removalID, subjectKind, reference, scope, now, now.Add(s.options.LiveRemovalDelay), now.Add(s.options.RecoverySanitizeDelay)); err != nil {
		return removalRequest{}, err
	}
	var request removalRequest
	err = tx.QueryRow(ctx, `
		SELECT removal_id,status,verified_at,live_delete_due_at,recovery_sanitize_due_at
		FROM online_removal_requests
		WHERE subject_kind=$1 AND subject_id=$2 AND scope=$3`, subjectKind, reference, scope).
		Scan(&request.RemovalID, &request.Status, &request.VerifiedAt, &request.LiveDeleteDueAt, &request.RecoverySanitizeDueAt)
	if err != nil {
		return removalRequest{}, err
	}
	request.VerifiedAt = request.VerifiedAt.UTC()
	request.LiveDeleteDueAt = request.LiveDeleteDueAt.UTC()
	request.RecoverySanitizeDueAt = request.RecoverySanitizeDueAt.UTC()
	return request, nil
}

// subjectMatch is one match of the subject.
type subjectMatch struct {
	MatchID string
	Seat    online.Seat
}

// subjectMatches lists the matches the subject took part in.
//
// The subject is named by its one-way reference, so the removal never stores
// or queries the subject identifier.
func (s *Service) subjectMatches(ctx context.Context, tx pgx.Tx, subjectKind, reference string) ([]subjectMatch, error) {
	rows, err := tx.Query(ctx, `SELECT match_id,seat FROM online_seats WHERE owner_kind=$1 AND `+subject.SQLReference("owner_id")+` = $2 ORDER BY match_id`, subjectKind, reference)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	matches := make([]subjectMatch, 0)
	for rows.Next() {
		var (
			match subjectMatch
			seat  string
		)
		if err = rows.Scan(&match.MatchID, &seat); err != nil {
			return nil, err
		}
		match.Seat = online.Seat(seat)
		matches = append(matches, match)
	}
	return matches, rows.Err()
}

// applyMatchRemoval removes one shared game of the subject.
//
// The legacy deletion marker is written first. The seat guard and the replay
// guard of the base schema both require that marker, so the anonymization
// and the erasure are only accepted when a recorded marker exists for the
// subject and the match.
//
// The marker carries the one-way reference of the subject, so the marker
// table never retains the identifier of an erased subject.
func (s *Service) applyMatchRemoval(ctx context.Context, tx pgx.Tx, removalID, subjectKind, reference, scope string, match subjectMatch) error {
	now := s.now()
	reason := "account_deletion"
	if scope == ScopeExplicitRemoval {
		reason = "erasure_request"
	}
	markerID, err := newIdentifier("dm_")
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO online_deletion_markers(marker_id,marker_kind,subject_kind,subject_id,match_id,reason,requested_at,applied_at)
		VALUES($1,'account_anonymization',$2,$3,$4,$5,$6,$6)
		ON CONFLICT (marker_id) DO NOTHING`,
		markerID, subjectKind, reference, match.MatchID, reason, now); err != nil {
		return err
	}
	if scope == ScopeExplicitRemoval {
		removalMarker, err := newIdentifier("dm_")
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `
			INSERT INTO online_deletion_markers(marker_id,marker_kind,subject_kind,subject_id,match_id,reason,requested_at,applied_at)
			VALUES($1,'replay_removal',$2,$3,$4,$5,$6,$6)
			ON CONFLICT (marker_id) DO NOTHING`,
			removalMarker, subjectKind, reference, match.MatchID, reason, now); err != nil {
			return err
		}
		// The public replay of the match leaves the public URL.
		if _, err = tx.Exec(ctx, `UPDATE online_public_replays SET replay_json='{}'::jsonb, revoked_at=$1, revocation_marker_id=$2 WHERE match_id=$3 AND revoked_at IS NULL`,
			now, removalMarker, match.MatchID); err != nil {
			return err
		}
		// The older projection of the match writer leaves the public URL too.
		if _, err = tx.Exec(ctx, `UPDATE online_public_projections SET projection_json='{}'::jsonb, revoked_at=$1, revocation_marker_id=$2 WHERE match_id=$3 AND revoked_at IS NULL`,
			now, removalMarker, match.MatchID); err != nil {
			return err
		}
	} else {
		// The stored public replay keeps the shared game, with the deleted
		// participant as "Deleted player".
		if _, err = tx.Exec(ctx, `
			UPDATE online_public_replays
			SET replay_json = jsonb_set(replay_json, ARRAY['participants', $2::text, 'publicLabel'], '"Deleted player"'::jsonb)
			WHERE match_id=$1 AND revoked_at IS NULL`, match.MatchID, strconv.Itoa(participantIndex(match.Seat))); err != nil {
			return err
		}
		// The older projection of the match writer is anonymized as well.
		if _, err = tx.Exec(ctx, `
			UPDATE online_public_projections
			SET projection_json = jsonb_set(projection_json, ARRAY['participants', $2::text, 'publicLabel'], '"Deleted player"'::jsonb)
			WHERE match_id=$1 AND revoked_at IS NULL`, match.MatchID, strconv.Itoa(participantIndex(match.Seat))); err != nil {
			return err
		}
		// The opponent's history entry loses the deleted name.
		if _, err = tx.Exec(ctx, `
			UPDATE online_profile_results
			SET opponent_label='Deleted player', opponent_profile_id=NULL
			WHERE match_id=$1 AND seat <> $2`, match.MatchID, string(match.Seat)); err != nil {
			return err
		}
	}
	// The seat of the deleted participant keeps the game and loses the
	// identity. The subject is named by its reference, so the raw identifier
	// is never part of the statement.
	if _, err = tx.Exec(ctx, `
		UPDATE online_seats SET owner_id='anonymized', public_label='Deleted player'
		WHERE match_id=$1 AND seat=$2 AND owner_kind=$3 AND `+subject.SQLReference("owner_id")+` = $4`,
		match.MatchID, string(match.Seat), subjectKind, reference); err != nil {
		return err
	}
	// The removal ledger records the match, so a restore of an older backup
	// replays this removal before the restored database serves traffic.
	ledgerID, err := newIdentifier("rl_")
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO online_removal_ledger(ledger_id,removal_id,subject_kind,subject_id,match_id,scope,removed_at)
		VALUES($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (removal_id, match_id) DO NOTHING`,
		ledgerID, removalID, subjectKind, reference, match.MatchID, scope, now); err != nil {
		return err
	}
	return nil
}

// removePrivateOwnerData removes the service-held private owner data of the
// subject.
//
// The subject is named by its one-way reference, so the removal never stores
// or queries the subject identifier.
//
// The account keeps no public name, no chosen avatar, no guest link and no
// registered public label. The guest keeps no seat credential and no
// ownership proof.
func (s *Service) removePrivateOwnerData(ctx context.Context, tx pgx.Tx, subjectKind, reference, rawID, scope string) error {
	if subjectKind == string(online.ParticipantAccount) {
		// The public identity of the account is removed, the deletion is
		// recorded, the private data is purged and the friend and the queue
		// records are sanitized. The same steps run again when a restore
		// replays the removal, so an account that only had private data
		// stays removed.
		// The public identity of the account is removed. The profile row stays
		// as an anonymous shell, because the base schema keeps the profile
		// identifier immutable.
		if _, err := tx.Exec(ctx, `UPDATE online_public_profiles SET username=NULL, username_key=NULL, avatar_key='', updated_at=clock_timestamp() WHERE `+subject.SQLReference("account_id")+` = $1`, reference); err != nil {
			return err
		}
		// The explicit guest links of the account are revoked.
		if _, err := tx.Exec(ctx, `UPDATE online_profile_guest_links SET revoked_at=clock_timestamp(), revoked_reason=$2 WHERE `+subject.SQLReference("account_id")+` = $1 AND revoked_at IS NULL`, reference, scope); err != nil {
			return err
		}
		// The registered public labels of the account are revoked.
		if _, err := tx.Exec(ctx, `UPDATE online_account_public_labels SET revoked_at=clock_timestamp() WHERE `+subject.SQLReference("account_id")+` = $1 AND revoked_at IS NULL`, reference); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO online_account_deletions(deletion_id,account_id,requested_at,applied_at,removal_id)
			VALUES($1,$2,$3,$3,(SELECT removal_id FROM online_removal_requests WHERE subject_kind='account' AND subject_id=$2 AND scope=$4))
			ON CONFLICT (account_id) DO NOTHING`, deletionID(), reference, s.now(), scope); err != nil {
			return err
		}
		// The private single-owner data of the account is removed as well: the
		// owner's own games, their archive chunks, their archive events and
		// their operation receipts. Only the payload free tombstones remain.
		if privateOwnerRemovalIsRequired(scope) {
			present, presentErr := privateTablesPresent(ctx, tx)
			if presentErr != nil {
				return presentErr
			}
			if present {
				if _, err := s.removePrivateGames(ctx, tx, rawID); err != nil {
					return err
				}
			}

		}
		// The sessions of the account are revoked, so an old verified session
		// cannot use the account again. The fence comes before the sanitation.
		if err := s.fenceAccount(ctx, tx, rawID, revocationReason(scope)); err != nil {
			return err
		}
		// The friend and the queue records of the account are sanitized as
		// well: an unused invitation preview must not name a removed owner.
		if err := s.removeAuxiliaryPersonalData(ctx, tx, subjectKind, rawID); err != nil {
			return err
		}
		return nil
	}
	// The guest keeps no seat credential and no ownership proof.
	if _, err := tx.Exec(ctx, `UPDATE online_guest_seat_credentials SET revoked_at=clock_timestamp(), revoked_reason='erasure_request' WHERE `+subject.SQLReference("guest_id")+` = $1 AND revoked_at IS NULL`, reference); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE online_guest_ownership_proofs SET revoked_at=clock_timestamp(), revoked_reason='erasure_request' WHERE `+subject.SQLReference("guest_id")+` = $1 AND revoked_at IS NULL`, reference); err != nil {
		return err
	}
	// The friend records of the guest are sanitized as well: an unused
	// invitation preview must not name a removed guest.
	if err := s.removeAuxiliaryPersonalData(ctx, tx, subjectKind, rawID); err != nil {
		return err
	}
	return nil
}

// revocationReason is the recorded reason of the session fence.
func revocationReason(scope string) string {
	if scope == ScopeExplicitRemoval {
		return "erasure_request"
	}
	return "account_deletion"
}

// participantIndex is the index of a seat in the public participant list.
func participantIndex(seat online.Seat) int {
	if seat == online.SeatBlack {
		return 1
	}
	return 0
}

// matchIDs returns the match identifiers of a list of subject matches.
func matchIDs(matches []subjectMatch) []string {
	ids := make([]string, 0, len(matches))
	for _, match := range matches {
		ids = append(ids, match.MatchID)
	}
	return ids
}

// SubjectReference is the one-way reference of a subject.
//
// The removal tables, the deletion marker and the removal ledger carry the
// reference instead of the subject identifier, so a removal never retains the
// identifier of the subject it removed.
func SubjectReference(subjectID string) string {
	return subject.Reference(subjectID)
}

// deletionID returns a random identifier for an account deletion record.
func deletionID() string {
	id, err := newIdentifier("rd_")
	if err != nil {
		return "rd_undetermined"
	}
	return id
}

// newIdentifier returns a random, non-secret identifier for a stored row.
func newIdentifier(prefix string) (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("privacy: secure random source unavailable")
	}
	return prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}
