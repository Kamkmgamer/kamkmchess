// Command migrate applies the PostgreSQL migrations embedded in the application.
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return errors.New("database initialization failed")
	}
	defer pool.Close()
	if err = pool.Ping(ctx); err != nil {
		return errors.New("database is unavailable")
	}
	if err = migrations.Apply(ctx, pool); err != nil {
		return errors.New("database migrations failed")
	}
	return nil
}
