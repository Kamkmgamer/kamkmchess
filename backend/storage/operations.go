package storage

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
)

// ReadArchives returns each accepted chunk record byte-for-byte in sequence order.
func (s *Store) ReadArchives(ctx context.Context, owner, gameID string, after int64, limit int) ([]ArchiveChunk, error) {
	if owner == "" || gameID == "" || after < -1 {
		return nil, ErrInvalidArgument
	}
	if _, err := s.Get(ctx, owner, gameID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(ctx, `SELECT sequence,raw_json,sha256 FROM archive_chunks WHERE game_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`, gameID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ArchiveChunk, 0)
	for rows.Next() {
		var item ArchiveChunk
		if err = rows.Scan(&item.Sequence, &item.RawJSON, &item.SHA256); err != nil {
			return nil, err
		}
		item.RawJSON = append([]byte(nil), item.RawJSON...)
		out = append(out, item)
	}
	return out, rows.Err()
}

// ReadEvents returns exact accepted event DTO bytes in sequence order.
func (s *Store) ReadEvents(ctx context.Context, owner, gameID string, after int64, limit int) ([]ArchiveEvent, error) {
	if owner == "" || gameID == "" || after < -1 {
		return nil, ErrInvalidArgument
	}
	if _, err := s.Get(ctx, owner, gameID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.Query(ctx, `SELECT sequence,raw_json FROM archive_events WHERE game_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`, gameID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ArchiveEvent, 0)
	for rows.Next() {
		var v ArchiveEvent
		if err = rows.Scan(&v.Sequence, &v.RawJSON); err != nil {
			return nil, err
		}
		v.RawJSON = append([]byte(nil), v.RawJSON...)
		out = append(out, v)
	}
	return out, rows.Err()
}

// ReadArchiveBatch returns a versioned envelope for all accepted archive records.
func (s *Store) ReadArchiveBatch(ctx context.Context, owner, gameID string) ([]byte, error) {
	if owner == "" || gameID == "" {
		return nil, ErrInvalidArgument
	}
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	game, err := scanGame(tx.QueryRow(ctx, `SELECT `+gameCols+` FROM games WHERE owner_id=$1 AND game_id=$2 AND deleted_at IS NULL`, owner, gameID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var events []ArchiveEvent
	var chunks []ArchiveChunk
	erows, err := tx.Query(ctx, `SELECT sequence,raw_json FROM archive_events WHERE game_id=$1 ORDER BY sequence`, gameID)
	if err != nil {
		return nil, err
	}
	for erows.Next() {
		var v ArchiveEvent
		if err = erows.Scan(&v.Sequence, &v.RawJSON); err != nil {
			erows.Close()
			return nil, err
		}
		v.RawJSON = append([]byte(nil), v.RawJSON...)
		events = append(events, v)
	}
	err = erows.Err()
	erows.Close()
	if err != nil {
		return nil, err
	}
	crows, err := tx.Query(ctx, `SELECT sequence,raw_json,sha256 FROM archive_chunks WHERE game_id=$1 ORDER BY sequence`, gameID)
	if err != nil {
		return nil, err
	}
	for crows.Next() {
		var v ArchiveChunk
		if err = crows.Scan(&v.Sequence, &v.RawJSON, &v.SHA256); err != nil {
			crows.Close()
			return nil, err
		}
		v.RawJSON = append([]byte(nil), v.RawJSON...)
		chunks = append(chunks, v)
	}
	err = crows.Err()
	crows.Close()
	if err != nil {
		return nil, err
	}
	var ev, ch []json.RawMessage
	for _, v := range events {
		ev = append(ev, append([]byte(nil), v.RawJSON...))
	}
	for _, v := range chunks {
		ch = append(ch, append([]byte(nil), v.RawJSON...))
	}
	var checkpoint struct {
		Revision int64 `json:"revision"`
	}
	if json.Unmarshal(game.CheckpointJSON, &checkpoint) != nil {
		return nil, ErrInvalidDTO
	}
	var eventAfter, eventThrough, chunkAfter, chunkThrough *int64
	if len(events) > 0 {
		b := events[len(events)-1].Sequence
		if events[0].Sequence > 0 {
			a := events[0].Sequence - 1
			eventAfter = &a
		}
		eventThrough = &b
	}
	if len(chunks) > 0 {
		b := chunks[len(chunks)-1].Sequence
		if chunks[0].Sequence > 0 {
			a := chunks[0].Sequence - 1
			chunkAfter = &a
		}
		chunkThrough = &b
	}
	baseRevision := game.Revision
	out, err := json.Marshal(struct {
		Format             string            `json:"format"`
		SchemaVersion      int               `json:"schemaVersion"`
		GameID             string            `json:"gameId"`
		BaseRevision       *int64            `json:"baseRevision"`
		BaseOwnershipEpoch int64             `json:"baseOwnershipEpoch"`
		CheckpointRevision int64             `json:"checkpointRevision"`
		EventsAfter        *int64            `json:"eventsAfterSequence"`
		EventsThrough      *int64            `json:"eventsThroughSequence"`
		ChunksAfter        *int64            `json:"chunksAfterSequence"`
		ChunksThrough      *int64            `json:"chunksThroughSequence"`
		Events             []json.RawMessage `json:"events"`
		Chunks             []json.RawMessage `json:"chunks"`
	}{"kamkmchess.cloud-archive-batch", 1, gameID, &baseRevision, game.Epoch, checkpoint.Revision, eventAfter, eventThrough, chunkAfter, chunkThrough, ev, ch})
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) Takeover(ctx context.Context, owner string, r CASRequest) (Game, error) {
	if owner == "" || r.GameID == "" {
		return Game{}, ErrInvalidArgument
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return Game{}, e
	}
	defer tx.Rollback(ctx)
	// The account gate is consulted inside the transaction, so a fenced
	// account cannot take a game over.
	if e = s.allowAccount(ctx, tx, owner); e != nil {
		return Game{}, e
	}
	g, e := scanGame(tx.QueryRow(ctx, `SELECT `+gameCols+` FROM games WHERE owner_id=$1 AND game_id=$2 FOR UPDATE`, owner, r.GameID))
	if errors.Is(e, pgx.ErrNoRows) {
		return Game{}, ErrNotFound
	}
	if e != nil {
		return Game{}, e
	}
	if g.DeletedAt != nil {
		return Game{}, ErrDeleted
	}
	if g.Revision != r.ExpectedRevision || g.Epoch != r.ExpectedEpoch {
		return Game{}, ErrConflict
	}
	g.Epoch++
	g.Revision++
	if _, e = tx.Exec(ctx, `UPDATE games SET revision=$1,ownership_epoch=$2,updated_at=now() WHERE game_id=$3`, g.Revision, g.Epoch, g.ID); e != nil {
		return Game{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return Game{}, e
	}
	return g, nil
}
func (s *Store) Delete(ctx context.Context, owner string, r CASRequest) error {
	if owner == "" || r.GameID == "" {
		return ErrInvalidArgument
	}
	tx, e := s.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	g, e := scanGame(tx.QueryRow(ctx, `SELECT `+gameCols+` FROM games WHERE owner_id=$1 AND game_id=$2 FOR UPDATE`, owner, r.GameID))
	if errors.Is(e, pgx.ErrNoRows) {
		var deleted bool
		_ = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM deletion_tombstones WHERE game_id=$1 AND owner_id=$2)`, r.GameID, owner).Scan(&deleted)
		if deleted {
			return nil
		}
		return ErrNotFound
	}
	if e != nil {
		return e
	}
	if g.DeletedAt != nil {
		return nil
	}
	if g.Revision != r.ExpectedRevision || g.Epoch != r.ExpectedEpoch {
		return ErrConflict
	}
	if _, e = tx.Exec(ctx, `UPDATE games SET ownership_epoch=ownership_epoch+1,deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE game_id=$1`, r.GameID); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO deletion_tombstones(game_id,owner_id,last_revision,last_epoch) VALUES($1,$2,$3,$4) ON CONFLICT(game_id) DO NOTHING`, r.GameID, owner, g.Revision, g.Epoch+1); e != nil {
		return e
	}
	// Deletion keeps only payload-free idempotency receipts and the tombstone.
	if _, e = tx.Exec(ctx, `DELETE FROM archive_chunks WHERE game_id=$1`, r.GameID); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `DELETE FROM archive_events WHERE game_id=$1`, r.GameID); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE operations SET result_json='{}'::bytea,request_hash=decode(repeat('00',32),'hex') WHERE game_id=$1`, r.GameID); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE games SET checkpoint_json='{}'::bytea WHERE game_id=$1`, r.GameID); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (s *Store) LookupOperation(ctx context.Context, owner, gameID, operationID string) (Operation, error) {
	var o Operation
	e := s.db.QueryRow(ctx, `SELECT operation_id,game_id,request_hash,revision,ownership_epoch,accepted_at,result_json FROM operations WHERE owner_id=$1 AND game_id=$2 AND operation_id=$3`, owner, gameID, operationID).Scan(&o.ID, &o.GameID, &o.RequestHash, &o.Revision, &o.Epoch, &o.AcceptedAt, &o.ResultJSON)
	if errors.Is(e, pgx.ErrNoRows) {
		return Operation{}, ErrNotFound
	}
	return o, e
}
