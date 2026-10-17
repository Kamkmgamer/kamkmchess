package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	issuer := strings.TrimSpace(os.Getenv("CLERK_ISSUER"))
	jwksURL := strings.TrimSpace(os.Getenv("CLERK_JWKS_URL"))
	parties := csvEnv("CLERK_AUTHORIZED_PARTIES")
	origins := csvEnv("APP_ALLOWED_ORIGINS")
	if databaseURL == "" || issuer == "" || jwksURL == "" || len(parties) == 0 || len(origins) == 0 {
		return errors.New("server configuration incomplete: DATABASE_URL, Clerk issuer/JWKS/authorized parties, and app origins are required")
	}

	verifier, err := auth.NewVerifier(auth.Config{
		Issuer:            issuer,
		JWKSURL:           jwksURL,
		Audience:          strings.TrimSpace(os.Getenv("CLERK_AUDIENCE")),
		AuthorizedParties: parties,
		AllowedOrigins:    origins,
	})
	if err != nil {
		return errors.New("invalid Clerk verifier configuration")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return errors.New("database initialization failed")
	}
	defer pool.Close()
	if err = pool.Ping(ctx); err != nil {
		return errors.New("database is unavailable")
	}
	store, err := storage.Open(ctx, pool)
	if err != nil {
		return errors.New("storage initialization failed")
	}

	address := strings.TrimSpace(os.Getenv("API_LISTEN_ADDR"))
	if address == "" {
		address = ":8080"
	}
	server := &http.Server{
		Addr:              address,
		Handler:           httpapi.CORS(origins, httpapi.NewAuthenticated(store, verifier)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       20 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.ListenAndServe() }()
	select {
	case err = <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return errors.New("HTTP server failed")
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err = server.Shutdown(shutdownCtx); err != nil {
			return errors.New("HTTP server shutdown failed")
		}
	}
	return nil
}

func csvEnv(key string) []string {
	var values []string
	for _, item := range strings.Split(os.Getenv(key), ",") {
		value := strings.TrimSpace(item)
		if value == "" {
			continue
		}
		found := false
		for _, existing := range values {
			if existing == value {
				found = true
				break
			}
		}
		if !found {
			values = append(values, value)
		}
	}
	return values
}
