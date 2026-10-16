// Package migrations applies the application's explicitly versioned PostgreSQL schema.
package migrations

import (
	"context"
	"embed"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed 0001_storage.sql
var files embed.FS

// Apply applies migrations in order. Callers opt in explicitly; Open storage does not mutate schema.
func Apply(ctx context.Context, pool *pgxpool.Pool) error {
	if pool == nil {
		return fmt.Errorf("migrations: nil pool")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS kamkmchess_schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	var applied bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM kamkmchess_schema_migrations WHERE version=1)`).Scan(&applied); err != nil {
		return err
	}
	if !applied {
		sql, e := files.ReadFile("0001_storage.sql")
		if e != nil {
			return e
		}
		if _, err = tx.Exec(ctx, string(sql)); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `INSERT INTO kamkmchess_schema_migrations(version) VALUES(1)`); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
