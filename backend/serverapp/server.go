// Package serverapp composes the storage-only API for local and hosted entry points.
package serverapp

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	DatabaseURL string
	Clerk       auth.Config
}

// Load reads only server configuration. Its errors never include configured values.
func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		DatabaseURL: strings.TrimSpace(getenv("DATABASE_URL")),
		Clerk: auth.Config{
			Issuer:            strings.TrimSpace(getenv("CLERK_ISSUER")),
			JWKSURL:           strings.TrimSpace(getenv("CLERK_JWKS_URL")),
			Audience:          strings.TrimSpace(getenv("CLERK_AUDIENCE")),
			AuthorizedParties: csv(getenv("CLERK_AUTHORIZED_PARTIES")),
			AllowedOrigins:    csv(getenv("APP_ALLOWED_ORIGINS")),
		},
	}
	if cfg.DatabaseURL == "" || len(cfg.Clerk.AllowedOrigins) == 0 {
		return Config{}, errors.New("storage configuration incomplete")
	}
	if _, err := auth.NewVerifier(cfg.Clerk); err != nil {
		return Config{}, errors.New("invalid Clerk verifier configuration")
	}
	return cfg, nil
}

// Open never migrates the database. Use cmd/migrate with a separate role first.
func Open(ctx context.Context, cfg Config) (http.Handler, func(), error) {
	verifier, err := auth.NewVerifier(cfg.Clerk)
	if err != nil {
		return nil, nil, errors.New("invalid Clerk verifier configuration")
	}
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, nil, errors.New("database initialization failed")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, nil, errors.New("database is unavailable")
	}
	store, err := storage.Open(ctx, pool)
	if err != nil {
		pool.Close()
		return nil, nil, errors.New("storage initialization failed")
	}
	return httpapi.CORS(cfg.Clerk.AllowedOrigins, httpapi.NewAuthenticated(store, verifier)), pool.Close, nil
}

func csv(value string) []string {
	var result []string
	seen := map[string]bool{}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part != "" && !seen[part] {
			seen[part] = true
			result = append(result, part)
		}
	}
	return result
}
