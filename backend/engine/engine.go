// Package engine runs a native UCI chess engine for the server engine seat.
//
// The pool owns a bounded number of engine processes. A search borrows one
// process, asks for the best move of one position with a fixed think time,
// and returns the process. A process that misbehaves is killed and replaced on
// the next search, so one broken search never poisons the pool.
package engine

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Think time bounds. The server never searches longer than MaxThink, so one
// opponent cannot hold a process for long.
const (
	MinThink     = 100 * time.Millisecond
	MaxThink     = 10 * time.Second
	DefaultThink = time.Second
)

// ErrUnavailable reports that the engine could not answer.
var ErrUnavailable = errors.New("engine: unavailable")

// Config describes the pool.
type Config struct {
	// Path is the engine executable, for example /usr/games/stockfish.
	Path string
	// Size bounds the number of concurrent searches. Zero means 2.
	Size int
	// Threads and HashMB are passed to every process. Zero means 1 and 16.
	Threads int
	HashMB  int
}

// Pool hands out engine processes.
type Pool struct {
	config Config
	slots  chan *process
	mu     sync.Mutex
	closed bool
}

// Open checks that the executable speaks UCI and returns a pool.
func Open(ctx context.Context, config Config) (*Pool, error) {
	if strings.TrimSpace(config.Path) == "" {
		return nil, errors.New("engine: no executable configured")
	}
	if config.Size <= 0 {
		config.Size = 2
	}
	if config.Threads <= 0 {
		config.Threads = 1
	}
	if config.HashMB <= 0 {
		config.HashMB = 16
	}
	pool := &Pool{config: config, slots: make(chan *process, config.Size)}
	// One process is started at boot, so a broken installation stops the
	// boot instead of failing the first game.
	first, err := pool.start(ctx)
	if err != nil {
		return nil, err
	}
	pool.slots <- first
	for i := 1; i < config.Size; i++ {
		pool.slots <- nil
	}
	return pool, nil
}

// ClampThink keeps a requested think time inside the server bounds.
func ClampThink(think time.Duration) time.Duration {
	if think <= 0 {
		return DefaultThink
	}
	return min(MaxThink, max(MinThink, think))
}

var uciMove = regexp.MustCompile(`^[a-h][1-8][a-h][1-8][qrbn]?$`)

// BestMove searches one position and returns the engine's move in
// coordinate form.
func (p *Pool) BestMove(ctx context.Context, fen string, think time.Duration) (string, error) {
	if strings.ContainsAny(fen, "\r\n") || len(fen) > 128 {
		return "", fmt.Errorf("%w: invalid position", ErrUnavailable)
	}
	var slot *process
	select {
	case slot = <-p.slots:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	move, err := p.search(ctx, &slot, fen, ClampThink(think))
	p.slots <- slot
	return move, err
}

func (p *Pool) search(ctx context.Context, slot **process, fen string, think time.Duration) (string, error) {
	if *slot == nil {
		started, err := p.start(ctx)
		if err != nil {
			return "", err
		}
		*slot = started
	}
	proc := *slot
	move, err := proc.bestMove(ctx, fen, think)
	if err != nil {
		proc.kill()
		*slot = nil
		return "", err
	}
	return move, nil
}

// Close stops every idle process. Searches in flight finish on their own and
// their processes are stopped when they are returned.
func (p *Pool) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	p.closed = true
	for range cap(p.slots) {
		if proc := <-p.slots; proc != nil {
			proc.kill()
		}
	}
}

type process struct {
	cmd   *exec.Cmd
	in    io.WriteCloser
	lines chan string
}

func (p *Pool) start(ctx context.Context) (*process, error) {
	cmd := exec.Command(p.config.Path)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if err = cmd.Start(); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	proc := &process{cmd: cmd, in: in, lines: make(chan string, 64)}
	go func() {
		scanner := bufio.NewScanner(out)
		for scanner.Scan() {
			proc.lines <- scanner.Text()
		}
		close(proc.lines)
	}()
	startCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err = proc.send("uci"); err == nil {
		_, err = proc.await(startCtx, "uciok")
	}
	if err == nil {
		err = proc.send(fmt.Sprintf("setoption name Threads value %d", p.config.Threads), fmt.Sprintf("setoption name Hash value %d", p.config.HashMB), "isready")
	}
	if err == nil {
		_, err = proc.await(startCtx, "readyok")
	}
	if err != nil {
		proc.kill()
		return nil, err
	}
	return proc, nil
}

func (proc *process) send(commands ...string) error {
	for _, command := range commands {
		if _, err := io.WriteString(proc.in, command+"\n"); err != nil {
			return fmt.Errorf("%w: %v", ErrUnavailable, err)
		}
	}
	return nil
}

// await reads lines until one starts with prefix.
func (proc *process) await(ctx context.Context, prefix string) (string, error) {
	for {
		select {
		case line, ok := <-proc.lines:
			if !ok {
				return "", fmt.Errorf("%w: the engine exited", ErrUnavailable)
			}
			if strings.HasPrefix(line, prefix) {
				return line, nil
			}
		case <-ctx.Done():
			return "", fmt.Errorf("%w: %v", ErrUnavailable, ctx.Err())
		}
	}
}

func (proc *process) bestMove(ctx context.Context, fen string, think time.Duration) (string, error) {
	// The new game resets the hash, so one game never learns from another.
	if err := proc.send("ucinewgame", "position fen "+fen, fmt.Sprintf("go movetime %d", think.Milliseconds())); err != nil {
		return "", err
	}
	searchCtx, cancel := context.WithTimeout(ctx, think+5*time.Second)
	defer cancel()
	line, err := proc.await(searchCtx, "bestmove")
	if err != nil {
		return "", err
	}
	fields := strings.Fields(line)
	if len(fields) < 2 || !uciMove.MatchString(fields[1]) {
		// "bestmove (none)" means the position has no legal move. The
		// rules service ends such a game before the engine is asked.
		return "", fmt.Errorf("%w: no move", ErrUnavailable)
	}
	return fields[1], nil
}

func (proc *process) kill() {
	_ = proc.in.Close()
	if proc.cmd.Process != nil {
		_ = proc.cmd.Process.Kill()
	}
	_ = proc.cmd.Wait()
}
