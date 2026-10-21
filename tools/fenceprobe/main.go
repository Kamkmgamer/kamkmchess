//go:build fenceprobe

// Command fenceprobe exercises the durable restore fence of the privacy
// service from the outside.
//
// It uses the real fence code of the privacy service, so the proof in
// deploy/verify-fence-access.mjs does not restate the file semantics: it
// writes, observes and clears the fence exactly the way the restore and the
// API do.
//
// The build tag keeps it out of every production binary.
//
// Usage:
//
//	fenceprobe write  <path> <restore-id> <ledger-digest-hex>
//	fenceprobe state  <path>
//	fenceprobe clear  <path>
//
// The state command exits with 0 when the fence is closed and with 3 when it
// is open, so a caller can act on the state without parsing the output.

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 3 {
		return errors.New("usage: fenceprobe write|state|clear <path> [restore-id] [digest-hex]")
	}
	command := os.Args[1]
	path := os.Args[2]

	// The fence never touches the database. The pool is created lazily and is
	// only there because the service requires one.
	pool, err := pgxpool.New(context.Background(), "postgres://127.0.0.1:1/unused")
	if err != nil {
		return errors.New("fence probe could not prepare the service")
	}
	defer pool.Close()
	service, err := privacy.Open(context.Background(), pool, nil, privacy.Options{FencePath: path})
	if err != nil {
		return errors.New("fence probe could not open the privacy service")
	}

	switch command {
	case "serve":
		// The helper serves the production serving gate over HTTP, so the
		// proof can show the real refusal and the real resume.
		if len(os.Args) < 5 {
			return errors.New("serve needs a database url and a port")
		}
		// The arguments are: serve <fence path> <database url> <port>.
		return serve(os.Args[3], os.Args[4], os.Args[2])
	case "write":
		if len(os.Args) < 5 {
			return errors.New("write needs a restore id and a ledger digest")
		}
		digest, err := hex.DecodeString(os.Args[4])
		if err != nil {
			return errors.New("the ledger digest is not hexadecimal")
		}
		if err := service.WriteFence(os.Args[3], digest); err != nil {
			return err
		}
		fmt.Println("written")
		return nil
	case "state":
		open, err := service.FenceOpen()
		if err != nil {
			// An unreadable fence is an open fence, and the error says why.
			fmt.Println("unreadable")
			return err
		}
		if open {
			fmt.Println("open")
			os.Exit(3)
		}
		fmt.Println("closed")
		return nil
	case "clear":
		if err := service.ClearFence(); err != nil {
			return err
		}
		fmt.Println("cleared")
		return nil
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

// serve mounts the production serving gate in front of a health handler.
//
// The gate is the real one: while the restore fence is open, every request is
// refused with the retryable answer, and after the fence is closed the
// service serves again.
func serve(databaseURL, port, fencePath string) error {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("fence probe could not prepare the database pool: %w", err)
	}
	defer pool.Close()
	if err = pool.Ping(ctx); err != nil {
		return errors.New("fence probe could not reach the database")
	}
	schema := "fence_probe_" + randomSuffix()
	if _, err = pool.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		return errors.New("fence probe could not create its schema")
	}
	defer func() { _, _ = pool.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE") }()

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return errors.New("fence probe could not parse the database url")
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = map[string]string{}
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	scoped, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return errors.New("fence probe could not open the scoped pool")
	}
	defer scoped.Close()
	if err = migrations.Apply(ctx, scoped); err != nil {
		return errors.New("fence probe could not apply the migrations")
	}

	service, err := privacy.Open(ctx, scoped, nil, privacy.Options{FencePath: fencePath})
	if err != nil {
		return errors.New("fence probe could not open the privacy service")
	}
	handler := httpapi.WithServingGate(service, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("serving"))
	}))
	server := &http.Server{
		// The listener binds every interface of the throwaway container, so the
		// published port reaches it. The container itself is isolated and the
		// publication is on the loopback of the host.
		Addr:              "0.0.0.0:" + port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	fmt.Println("serving")
	return server.ListenAndServe()
}

// randomSuffix returns a short random identifier.
func randomSuffix() string {
	buffer := make([]byte, 4)
	if _, err := rand.Read(buffer); err != nil {
		return "probe"
	}
	return fmt.Sprintf("%x", buffer)
}
