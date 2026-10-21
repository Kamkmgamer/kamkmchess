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
	"encoding/hex"
	"errors"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

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
