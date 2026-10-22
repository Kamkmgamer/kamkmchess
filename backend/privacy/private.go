package privacy

import (
	"context"
	"errors"

	"github.com/Kamkmgamer/kamkmchess/backend/storage"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
	"github.com/jackc/pgx/v5"
)

// The private single-owner data of an account.
//
// The private sync API is a different surface from the online service: it
// stores the owner's own games, their archive chunks, their archive events and
// their operation receipts. An ordinary account deletion removes that data
// as well, because the approved handoff says the deleted owner's service-held
// private data is removed.
//
// The removal is a payload purge with a tombstone: the game row stays, its
// checkpoint and its archives are emptied, and the tombstone records the
// deletion, exactly like the delete path of the private store. The unrelated
// owners are never touched, and the browser's own copies are outside the
// server's reach.

// AccountAllowed reports whether the account may still use the private
// store.
//
// The account is fenced when its sessions were revoked or when its public
// identity was deleted. The check is the one the private store consults
// inside its write transactions, so a deleted account cannot write again, not
// even with a session token that still verifies.
func (s *Service) AccountAllowed(ctx context.Context, q storage.Querier, owner string) (bool, error) {
	if owner == "" {
		return false, nil
	}
	var revoked bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM online_session_revocations WHERE subject_id=$1 AND session_id='*')`, owner).Scan(&revoked); err != nil {
		return false, err
	}
	if revoked {
		return false, nil
	}
	var deleted bool
	if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM online_account_deletions WHERE account_id=$1)`, subject.Reference(owner)).Scan(&deleted); err != nil {
		return false, err
	}
	return !deleted, nil
}

// applyPrivateRemovals removes the private single-owner data of every deleted
// account again.
//
// A restored database holds the private rows of a deleted account again, and
// the removal ledger replays the removal. The account is found by its
// one-way reference, and the account identifier is read from the private rows
// themselves, so the removal tables never have to store it.
func (s *Service) applyPrivateRemovals(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT account_id FROM online_account_deletions`)
	if err != nil {
		return err
	}
	references := make([]string, 0)
	for rows.Next() {
		var reference string
		if err = rows.Scan(&reference); err != nil {
			rows.Close()
			return err
		}
		references = append(references, reference)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, reference := range references {
		owners, err := s.subjectOwnerIDs(ctx, s.db, reference)
		if err != nil {
			return err
		}
		for _, owner := range owners {
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return err
			}
			removed, err := s.removePrivateGames(ctx, tx, owner)
			if err != nil {
				_ = tx.Rollback(ctx)
				return err
			}
			if err = s.fenceAccount(ctx, tx, owner, "account_deletion"); err != nil {
				_ = tx.Rollback(ctx)
				return err
			}
			// The friend and the queue records of the account are sanitized
			// again.
			if err = s.removeAuxiliaryPersonalData(ctx, tx, "account", owner); err != nil {
				_ = tx.Rollback(ctx)
				return err
			}
			if err = tx.Commit(ctx); err != nil {
				return err
			}
			_ = removed
		}
	}
	return nil
}

// privateOwners returns the account identifiers of the private rows of a
// deleted account.
//
// The account is found by its one-way reference, and the identifier is read
// from the rows themselves, so it is never stored in a removal table.
func (s *Service) privateOwners(ctx context.Context, reference string) ([]string, error) {
	present, err := privateTablesPresent(ctx, s.db)
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, nil
	}
	rows, err := s.db.Query(ctx, `SELECT DISTINCT owner_id FROM games WHERE `+subject.SQLReference("owner_id")+` = $1`, reference)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	owners := make([]string, 0)
	for rows.Next() {
		var owner string
		if err = rows.Scan(&owner); err != nil {
			return nil, err
		}
		owners = append(owners, owner)
	}
	return owners, rows.Err()
}

// subjectOwnerIDs returns the identifiers of a removed subject.
//
// The identifiers are read from the rows that still name the subject: the
// seats of its matches and the private games it owned. The removal tables
// never store them.
func (s *Service) subjectOwnerIDs(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, reference string) ([]string, error) {
	owners := make([]string, 0)
	seen := map[string]bool{}
	collect := func(owner string) {
		if owner == "" || owner == "anonymized" || seen[owner] {
			return
		}
		seen[owner] = true
		owners = append(owners, owner)
	}
	present, err := auxiliaryTablesPresent(ctx, q, "online_seats")
	if err != nil {
		return nil, err
	}
	if present {
		rows, err := q.Query(ctx, `SELECT DISTINCT owner_id FROM online_seats WHERE `+subject.SQLReference("owner_id")+` = $1`, reference)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var owner string
			if err = rows.Scan(&owner); err != nil {
				rows.Close()
				return nil, err
			}
			collect(owner)
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			return nil, err
		}
	}
	privateOwners, err := s.privateOwners(ctx, reference)
	if err != nil {
		return nil, err
	}
	for _, owner := range privateOwners {
		collect(owner)
	}
	// The friend and the queue records of the subject name it as well. A
	// subject that played no match and owned no private game is only named
	// there, and its removal still has to reach those records.
	auxiliary, err := s.auxiliaryOwnerIDs(ctx, q, reference)
	if err != nil {
		return nil, err
	}
	for _, owner := range auxiliary {
		collect(owner)
	}
	return owners, nil
}

// auxiliaryOwnerIDs returns the identifiers of a removed subject that the
// friend and the queue records name.
//
// The records are read before they are sanitized, so a restored database
// still yields the identifier of the subject it has to remove.
func (s *Service) auxiliaryOwnerIDs(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, reference string) ([]string, error) {
	owners := make([]string, 0)
	read := func(table, column string) error {
		present, err := auxiliaryTablesPresent(ctx, q, table)
		if err != nil {
			return err
		}
		if !present {
			return nil
		}
		rows, err := q.Query(ctx, `SELECT DISTINCT `+column+` FROM `+table+` WHERE `+subject.SQLReference(column)+` = $1`, reference)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var owner string
			if err = rows.Scan(&owner); err != nil {
				return err
			}
			owners = append(owners, owner)
		}
		return rows.Err()
	}
	for _, source := range []struct{ table, column string }{
		// The public profile of the account is the only place that still names
		// a subject that played no match and owned no private game.
		{"online_public_profiles", "account_id"},
		{"online_friend_invitations", "inviter_id"},
		{"online_friend_invitations", "recipient_account_id"},
		{"online_invitation_acceptances", "acceptor_id"},
		{"online_rematch_offers", "proposer_id"},
		{"online_queue_entries", "owner_id"},
	} {
		if err := read(source.table, source.column); err != nil {
			return nil, err
		}
	}
	return owners, nil
}

// AccountMayUseStore reports whether the account may still use the private
// store, outside a transaction.
//
// The private API consults it before it serves a read or a write, so a deleted
// account cannot read its own private archive any more.
func (s *Service) AccountMayUseStore(ctx context.Context, accountID string) (bool, error) {
	return s.AccountAllowed(ctx, s.db, accountID)
}

// removePrivateGames removes the private single-owner data of one account.
//
// The rows are the games of the account, their archive chunks, their archive
// events and their operation receipts. Only the payload free tombstones and
// the idempotency receipts remain, so a restored or replayed copy of the
// archive cannot bring the data back.
func (s *Service) removePrivateGames(ctx context.Context, tx pgx.Tx, accountID string) (int, error) {
	rows, err := tx.Query(ctx, `SELECT game_id,revision,ownership_epoch FROM games WHERE owner_id=$1 ORDER BY game_id FOR UPDATE`, accountID)
	if err != nil {
		return 0, err
	}
	type privateGame struct {
		id       string
		revision int64
		epoch    int64
	}
	games := make([]privateGame, 0)
	for rows.Next() {
		var game privateGame
		if err = rows.Scan(&game.id, &game.revision, &game.epoch); err != nil {
			rows.Close()
			return 0, err
		}
		games = append(games, game)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, err
	}
	for _, game := range games {
		if _, err = tx.Exec(ctx, `UPDATE games SET ownership_epoch=ownership_epoch+1,deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE game_id=$1`, game.id); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO deletion_tombstones(game_id,owner_id,last_revision,last_epoch) VALUES($1,$2,$3,$4) ON CONFLICT(game_id) DO NOTHING`, game.id, accountID, game.revision, game.epoch+1); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM archive_chunks WHERE game_id=$1`, game.id); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM archive_events WHERE game_id=$1`, game.id); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `UPDATE operations SET result_json='{}'::bytea,request_hash=decode(repeat('00',32),'hex') WHERE game_id=$1`, game.id); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `UPDATE games SET checkpoint_json='{}'::bytea WHERE game_id=$1`, game.id); err != nil {
			return 0, err
		}
	}
	return len(games), nil
}

// fenceAccount revokes the sessions of the account and records the deletion.
//
// The fence comes before the sanitation, so a command that is already running
// is ordered against the removal instead of committing after it.
func (s *Service) fenceAccount(ctx context.Context, tx pgx.Tx, accountID, reason string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO online_session_revocations(subject_id,session_id,revoked_at,reason) VALUES($1,'*',clock_timestamp(),$2) ON CONFLICT (subject_id, session_id) DO NOTHING`, accountID, reason); err != nil {
		return err
	}
	return nil
}

// privateOwnerRemovalIsRequired reports whether the private data of the
// account has to be removed in this scope.
//
// Both scopes remove it: the ordinary account deletion removes the private
// owner data, and the explicit removal removes it as well.
func privateOwnerRemovalIsRequired(scope string) bool {
	return scope == ScopeAccountDeletion || scope == ScopeExplicitRemoval
}

// errPrivateTablesMissing reports a database without the private sync tables.
var errPrivateTablesMissing = errors.New("privacy: the private sync tables are missing")

// privateTablesPresent reports whether the private sync tables exist.
//
// A database that never had the private sync schema has nothing to remove, so
// the removal is a no-op there.
func privateTablesPresent(ctx context.Context, q storage.Querier) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='games')`).Scan(&exists)
	if err != nil {
		return false, err
	}
	return exists, nil
}
