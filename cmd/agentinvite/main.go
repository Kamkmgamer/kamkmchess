// Command agentinvite issues an invite code for the official agent runner.
// Games started with the code count on the verified agent board.
//
//	DATABASE_URL=... go run ./cmd/agentinvite --label "Opus 5.5 runs" --uses 20
//
// The code is printed once; only its hash is stored.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/agentboards"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	label := flag.String("label", "", "What the code is for, e.g. the model it will verify")
	uses := flag.Int("uses", 10, "How many games the code can start")
	flag.Parse()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return errors.New("DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return errors.New("database initialization failed")
	}
	defer pool.Close()
	id, code, err := agentboards.New(pool).IssueInvite(ctx, *label, *uses)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "invite %s: %d uses. Store the code now; it is not shown again.\n", id, *uses)
	fmt.Println(code)
	return nil
}
