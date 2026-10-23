package engine

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"
)

// enginePath returns the native engine for the tests. The tests skip when it
// is missing, the same way the PostgreSQL tests skip without a database.
func enginePath(t *testing.T) string {
	t.Helper()
	path := os.Getenv("KAMKM_ENGINE_PATH")
	if path == "" {
		path = "/usr/games/stockfish"
	}
	if _, err := os.Stat(path); err != nil {
		t.Skipf("no native engine at %s: set KAMKM_ENGINE_PATH", path)
	}
	return path
}

func TestClampThink(t *testing.T) {
	for _, tc := range []struct{ in, want time.Duration }{
		{0, DefaultThink}, {time.Millisecond, MinThink}, {time.Minute, MaxThink}, {2 * time.Second, 2 * time.Second},
	} {
		if got := ClampThink(tc.in); got != tc.want {
			t.Fatalf("ClampThink(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestOpenRefusesAMissingExecutable(t *testing.T) {
	if _, err := Open(context.Background(), Config{Path: "/nonexistent/stockfish"}); err == nil {
		t.Fatal("a missing executable opened")
	}
	if _, err := Open(context.Background(), Config{}); err == nil {
		t.Fatal("an empty path opened")
	}
}

func TestBestMoveFindsMateInOne(t *testing.T) {
	pool, err := Open(context.Background(), Config{Path: enginePath(t), Size: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	// Back-rank mate: Ra8#.
	move, err := pool.BestMove(context.Background(), "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", 200*time.Millisecond)
	if err != nil || move != "a1a8" {
		t.Fatalf("BestMove = %q, %v; want a1a8", move, err)
	}
}

func TestBestMoveServesConcurrentSearches(t *testing.T) {
	pool, err := Open(context.Background(), Config{Path: enginePath(t), Size: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var wg sync.WaitGroup
	errs := make(chan error, 5)
	for range 5 {
		wg.Go(func() {
			move, err := pool.BestMove(context.Background(), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", MinThink)
			if err == nil && !uciMove.MatchString(move) {
				t.Errorf("malformed move %q", move)
			}
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestBestMoveRecoversFromAKilledProcess(t *testing.T) {
	pool, err := Open(context.Background(), Config{Path: enginePath(t), Size: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	proc := <-pool.slots
	proc.kill()
	pool.slots <- proc
	if _, err = pool.BestMove(context.Background(), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", MinThink); err == nil {
		t.Fatal("a dead process answered")
	}
	move, err := pool.BestMove(context.Background(), "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", MinThink)
	if err != nil || move == "" {
		t.Fatalf("the pool did not replace the dead process: %q, %v", move, err)
	}
}

func TestBestMoveHonoursCancellation(t *testing.T) {
	pool, err := Open(context.Background(), Config{Path: enginePath(t), Size: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	busy := <-pool.slots
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err = pool.BestMove(ctx, "8/8/8/8/8/8/8/K6k w - - 0 1", MinThink); err == nil {
		t.Fatal("a search ran without a free process")
	}
	pool.slots <- busy
}
