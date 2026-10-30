// Package rulesworker owns the private, versioned Node rules process used by the
// Go match authority. The process receives a position, ordered FEN history and
// optional move or timeout intent over stdin and returns deterministic facts.
// It has no database, HTTP, authentication or provider access. A caller must
// still hold the match lock and reconcile clocks before committing a candidate
// against the same match version.
package rulesworker

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	ProtocolVersion    = 1
	RulesPolicyVersion = "online-rules/1"
	EngineName         = "chessops"
	EngineVersion      = "0.15.1"

	DefaultRequestTimeout   = 2 * time.Second
	DefaultMaxRequestBytes  = 256 << 10
	DefaultMaxResponseBytes = 1 << 20
	MaxFENLength            = 256
	MaxHistoryFENs          = 4096
	MaxLedgerEntries        = 4096
	MaxRequestIDLength      = 128
	MaxMatchVersion         = int64(1<<53 - 1)

	// DefaultStartTimeout bounds the cold start of the worker process.
	//
	// The start of the shared worker is a one-time cost of the host, not a
	// property of the request that needs the worker. It therefore has its
	// own budget, so a slow process start on a loaded host cannot consume
	// the exchange budget of the request that waits for it.
	DefaultStartTimeout = 10 * time.Second

	// ReadinessRequestID is the correlation token of the readiness probe.
	//
	// The probe is a facts-only request for the standard position. Its
	// reply proves that the worker booted and speaks the protocol, and the
	// reply itself is discarded.
	ReadinessRequestID = "kamkm-readiness"

	// standardStartingFEN is the position of the readiness probe. It is the
	// cheapest position the worker can evaluate, and it never carries a
	// move intent.
	standardStartingFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
)

var (
	ErrClosed         = errors.New("rules worker client is closed")
	ErrInvalidRequest = errors.New("invalid rules worker request")
	// ErrTimeout marks a request that ran out of its budget.
	//
	// It carries no context cause on purpose. A timeout of the worker is
	// not the deadline of the caller, and a caller that tells the two
	// apart must not record a genuine outage as a caller deadline.
	ErrTimeout = errors.New("rules worker timed out")
	// ErrCanceled marks a request that the caller canceled.
	//
	// It carries the cause of the context, so that a caller can tell a
	// cancellation from a failure of the worker. The health probe of the
	// service skips the downgrade of the rules dependency for a canceled
	// probe, and that guard needs the cause.
	ErrCanceled    = fmt.Errorf("%w: %w", errors.New("rules worker request was canceled"), context.Canceled)
	ErrCrashed     = errors.New("rules worker exited without a valid response")
	ErrMalformed   = errors.New("rules worker returned malformed output")
	ErrCorrelation = errors.New("rules worker response does not match the request")
	// ErrBusy marks a worker that is busy with another request.
	//
	// A busy worker is not an outage. A probe that finds the worker busy
	// reports it as busy and returns at once, so it never waits behind a
	// participant request, never spends the budget of that request, and
	// never makes a healthy worker look broken.
	ErrBusy = errors.New("rules worker is busy with another request")
)

// ErrNotStarted marks a probe of the intentionally cold worker. It remains in
// the busy class so health checks do not start the worker, but does not claim
// that another request is using it.
var ErrNotStarted error = notStartedError{}

type notStartedError struct{}

func (notStartedError) Error() string {
	return "rules worker has not started yet"
}

func (notStartedError) Is(target error) bool {
	return target == ErrBusy
}

// RejectionError is a valid protocol response that refused the input. It never
// contains a candidate.
type RejectionError struct {
	Code    string
	Message string
}

func (e *RejectionError) Error() string {
	return "rules worker rejected request: " + e.Code
}

type Config struct {
	// Entry is the built worker bundle, normally build/rules-worker/worker.mjs.
	// It is private server code and deliberately outside the public dist/ output.
	Entry string
	// Node defaults to node from PATH.
	Node string
	// RequestTimeout bounds the exchange of one request, including the
	// retries. A timeout terminates the process so a late reply cannot be
	// mistaken for a newer one.
	RequestTimeout time.Duration
	// StartTimeout bounds the cold start of the worker process and its
	// readiness probe. The start is a one-time cost of a shared resource,
	// so it has its own budget and never consumes the exchange budget of
	// the request that waits for it.
	StartTimeout     time.Duration
	MaxRequestBytes  int
	MaxResponseBytes int
}

type CoordinateMove struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Promotion string `json:"promotion,omitempty"`
}

type RepetitionEntry struct {
	Identity    string `json:"identity"`
	Occurrences string `json:"occurrences"`
}

type Repetition struct {
	Version int               `json:"version"`
	Entries []RepetitionEntry `json:"entries"`
}

type Intent struct {
	Kind         string
	From         string
	To           string
	Promotion    string
	ExpiredColor string
}

type Request struct {
	RequestID string
	// History is the ordered starting position followed by every accepted move's
	// resulting FEN. The last entry must equal FEN. The worker derives repetition
	// identity itself so Go carries no chess rules.
	History            []string
	MatchVersion       int64
	FEN                string
	Intent             *Intent
	RulesPolicyVersion string
}

type Engine struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type PieceCounts struct {
	Pawns   int `json:"p"`
	Knights int `json:"n"`
	Bishops int `json:"b"`
	Rooks   int `json:"r"`
	Queens  int `json:"q"`
	Kings   int `json:"k"`
}

type Material struct {
	White PieceCounts `json:"white"`
	Black PieceCounts `json:"black"`
	Total int         `json:"total"`
}

type Facts struct {
	InCheck              bool     `json:"inCheck"`
	HasLegalMoves        bool     `json:"hasLegalMoves"`
	Checkmate            bool     `json:"checkmate"`
	Stalemate            bool     `json:"stalemate"`
	InsufficientMaterial bool     `json:"insufficientMaterial"`
	RepetitionCount      string   `json:"repetitionCount"`
	ThirdRepetition      bool     `json:"thirdRepetition"`
	HundredHalfmoves     bool     `json:"hundredHalfmoves"`
	Deadness             string   `json:"deadness"`
	Ending               string   `json:"ending"`
	Material             Material `json:"material"`
	TimeoutWinner        *string  `json:"timeoutWinner"`
}

type Candidate struct {
	Move         CoordinateMove `json:"move"`
	SAN          string         `json:"san"`
	ResultingFEN string         `json:"resultingFen"`
	Ending       Facts          `json:"ending"`
	Repetition   Repetition     `json:"repetition"`
	Material     Material       `json:"material"`
}

type Input struct {
	FEN             string `json:"fen"`
	Identity        string `json:"identity"`
	RepetitionCount string `json:"repetitionCount"`
}

// Response is returned only after protocol, version, engine, fingerprint,
// correlation and candidate-shape checks have passed.
type Response struct {
	ProtocolVersion    int        `json:"protocolVersion"`
	RequestID          string     `json:"requestId"`
	MatchVersion       int64      `json:"matchVersion"`
	RulesPolicyVersion string     `json:"rulesPolicyVersion"`
	InputFingerprint   string     `json:"inputFingerprint"`
	Engine             Engine     `json:"engine"`
	Input              Input      `json:"input"`
	Facts              Facts      `json:"facts"`
	Candidate          *Candidate `json:"candidate"`
}

type wireRequest struct {
	ProtocolVersion    int         `json:"protocolVersion"`
	RequestID          string      `json:"requestId"`
	RulesPolicyVersion string      `json:"rulesPolicyVersion"`
	MatchVersion       int64       `json:"matchVersion"`
	FEN                string      `json:"fen"`
	History            []string    `json:"history"`
	Intent             *wireIntent `json:"intent,omitempty"`
}

type wireIntent struct {
	Kind         string `json:"kind"`
	From         string `json:"from,omitempty"`
	To           string `json:"to,omitempty"`
	Promotion    string `json:"promotion,omitempty"`
	ExpiredColor string `json:"expiredColor,omitempty"`
}

type wireResponse struct {
	ProtocolVersion    int        `json:"protocolVersion"`
	Status             string     `json:"status"`
	RequestID          *string    `json:"requestId"`
	MatchVersion       int64      `json:"matchVersion"`
	RulesPolicyVersion string     `json:"rulesPolicyVersion"`
	InputFingerprint   string     `json:"inputFingerprint"`
	Engine             Engine     `json:"engine"`
	Input              Input      `json:"input"`
	Facts              *Facts     `json:"facts"`
	Candidate          *Candidate `json:"candidate"`
	Code               string     `json:"code"`
	Message            string     `json:"message"`
}

type Client struct {
	config Config

	// slot is a one-permit semaphore rather than a sync.Mutex so a queued
	// request can abandon the wait when its own deadline expires.
	slot   chan struct{}
	closed bool
	proc   *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	// ready records that the worker answered the readiness probe. A worker
	// that is running but not ready is restarted before the next exchange.
	ready bool
}

func New(config Config) (*Client, error) {
	normalized, err := normalizeConfig(config)
	if err != nil {
		return nil, err
	}
	return &Client{config: normalized, slot: make(chan struct{}, 1)}, nil
}

func normalizeConfig(config Config) (Config, error) {
	config.Entry = strings.TrimSpace(config.Entry)
	config.Node = strings.TrimSpace(config.Node)
	if config.Entry == "" {
		return Config{}, errors.New("rules worker entry is required")
	}
	details, err := os.Stat(config.Entry)
	if err != nil || !details.Mode().IsRegular() {
		return Config{}, errors.New("rules worker entry is not a readable file")
	}
	if config.Node == "" {
		config.Node = "node"
	}
	if runtime.GOOS == "windows" && strings.EqualFold(config.Node, "node") {
		// A Windows PATH may put a shell/cmd shim named node ahead of node.exe.
		// Killing that wrapper would leave the real worker running, so prefer
		// the executable when the default name is used.
		if executable, err := exec.LookPath("node.exe"); err == nil {
			config.Node = executable
		}
	}
	if config.RequestTimeout <= 0 {
		config.RequestTimeout = DefaultRequestTimeout
	}
	if config.StartTimeout <= 0 {
		config.StartTimeout = DefaultStartTimeout
	}
	if config.MaxRequestBytes <= 0 {
		config.MaxRequestBytes = DefaultMaxRequestBytes
	}
	if config.MaxResponseBytes <= 0 {
		config.MaxResponseBytes = DefaultMaxResponseBytes
	}
	return config, nil
}

// Evaluate sends one request and returns a validated response. Timeouts,
// cancellation, crashes, malformed output and mismatched correlation all
// terminate the process and return a zero Response.
//
// One deadline covers queueing behind another request, the exchange and the
// retries, so a request that waits for the worker cannot consume a fresh
// budget once it is admitted.
//
// The cold start of the worker is not charged to that deadline. The process
// start and the readiness probe are a one-time cost of a shared resource,
// and the host's process start latency is not a property of the request.
// The start has its own budget, and the time it spends is added back to the
// exchange deadline. Charging that cost to the request budget made a slow
// start on a loaded host fail the first request after a boot or after a
// restart, and the failure repeated itself: a timeout stops the worker, so
// the next request paid the start again.
func (c *Client) Evaluate(ctx context.Context, request Request) (Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	// The request budget covers the queue wait and the exchange. The internal
	// deadline is kept explicitly, because a derived context clamps its own
	// deadline to the earlier of the requested deadline and the deadline of
	// its parent.
	waitDeadline := time.Now().Add(c.config.RequestTimeout)
	wait, cancelWait := context.WithDeadline(ctx, waitDeadline)
	defer cancelWait()

	line, err := c.buildRequest(request)
	if err != nil {
		return Response{}, err
	}
	if err := c.acquire(wait, waitDeadline); err != nil {
		return Response{}, err
	}
	defer c.release()

	if err := wait.Err(); err != nil {
		return Response{}, exchangeError(waitDeadline, ctx)
	}
	if c.closed {
		return Response{}, ErrClosed
	}
	// The internal deadline is the one the client asked for, not the
	// clamped deadline of the derived context.
	expiry := waitDeadline
	// lastErr is the failure the exchange already reported. A deadline that
	// runs out afterwards must not replace it: a worker that died is a
	// crash, not a slow worker, and the caller needs the specific answer.
	// A later failure only replaces an earlier one when the earlier one was
	// the generic timeout.
	var lastErr error

	for attempt := 0; ; attempt++ {
		// The cancellation of the caller keeps its class, whatever else
		// happened before it.
		if errors.Is(ctx.Err(), context.Canceled) {
			return Response{}, ErrCanceled
		}
		if !time.Now().Before(expiry) {
			if lastErr != nil {
				return Response{}, lastErr
			}
			return Response{}, ErrTimeout
		}
		// The start has its own budget, and the caller's context still
		// bounds the whole call.
		startDeadline := time.Now().Add(c.config.StartTimeout)
		startCtx, cancelStart := context.WithDeadline(ctx, startDeadline)
		started := time.Now()
		readyErr := c.ensureReady(ctx, startCtx, startDeadline)
		startElapsed := time.Since(started)
		cancelStart()
		if readyErr != nil {
			// A failure of the start does not replace the specific failure
			// of an earlier attempt: a worker that died and a replacement
			// that never became ready is still a crash of the worker.
			if errors.Is(ctx.Err(), context.Canceled) {
				return Response{}, ErrCanceled
			}
			if lastErr != nil && !errors.Is(lastErr, ErrTimeout) {
				return Response{}, lastErr
			}
			return Response{}, readyErr
		}
		// The start is not charged to the exchange budget.
		expiry = expiry.Add(startElapsed)
		exchange, cancelExchange := context.WithDeadline(ctx, expiry)
		response, retry, exchangeErr := c.exchange(exchange, ctx, expiry, line, request)
		cancelExchange()
		if exchangeErr == nil {
			return response, nil
		}
		// The worker is stopped first. The exchange may have killed it, and
		// a killed worker must be reaped and must never stay the ready one
		// of the client.
		c.stop()
		// The cancellation of the caller keeps its class, even when a
		// specific failure of an earlier attempt is known.
		if errors.Is(ctx.Err(), context.Canceled) {
			return Response{}, ErrCanceled
		}
		// The specific failure wins. A retry that runs out of budget does
		// not turn a crash into a timeout.
		if lastErr == nil || (errors.Is(lastErr, ErrTimeout) && !errors.Is(exchangeErr, ErrTimeout)) {
			lastErr = exchangeErr
		}
		var rejection *RejectionError
		if errors.As(exchangeErr, &rejection) {
			return Response{}, rejection
		}
		if !retry || attempt >= 1 {
			// The failure that the exchange reported is the answer of the
			// call. A crash of an earlier attempt is not replaced by the
			// generic timeout of the last attempt.
			return Response{}, lastErr
		}
	}
}

// Probe reports whether the worker answers, and it never waits.
//
// A probe takes the worker slot only when the slot is free. When another
// request holds it, the probe reports `ErrBusy` and returns at once: it never
// queues behind a participant request, it never spends the budget of that
// request, and a busy worker is never reported as a broken one.
//
// A probe of a free worker performs a **real bounded exchange** with it. The
// readiness flag alone is not evidence: a worker that hung or exited after it
// became ready would look healthy forever. The exchange is bounded by the
// internal budgets of the client, so a caller deadline can never mask an
// outage of the worker. A worker that does not answer is killed, reaped and
// reset.
//
// A probe **does not start** a worker. A monitor must not warm the traffic
// path, and the cold start belongs to the request that needs the worker. A
// probe of a worker that is not running therefore reports the busy class and
// returns at once, without starting a process and without holding the slot
// for a start.
//
// The recovery of a worker that is gone is `Repair`.
func (c *Client) Probe(ctx context.Context) error {
	return c.probe(ctx, false)
}

// Repair starts the worker when it is not running and proves that it answers.
//
// It is the recovery path of a closed health gate. The caller serves no
// traffic then, so holding the worker slot for the cold start is safe, and
// the dependency comes back without waiting for a participant request.
//
// A repair of a worker that is running is a plain probe: the worker is
// talked to, and a worker that does not answer is killed, reaped and reset,
// so that the next repair starts a fresh one.
func (c *Client) Repair(ctx context.Context) error {
	return c.probe(ctx, true)
}

// probe is the shared body of the check and of the repair.
func (c *Client) probe(ctx context.Context, repair bool) error {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case c.slot <- struct{}{}:
	default:
		// The worker is busy with another request. That is not an outage.
		return ErrBusy
	}
	defer c.release()
	if c.closed {
		return ErrClosed
	}
	if c.proc == nil && !repair {
		// The worker is not running. A check does not start it: a monitor
		// must not warm the traffic path. It has not started yet, which is
		// distinct from another request holding its slot.
		return ErrNotStarted
	}
	// The worker has to be running and ready. The readiness probe is
	// itself a bounded exchange, so a worker that never becomes ready
	// fails here.
	startDeadline := time.Now().Add(c.config.StartTimeout)
	startCtx, cancelStart := context.WithDeadline(ctx, startDeadline)
	readyErr := c.ensureReady(ctx, startCtx, startDeadline)
	cancelStart()
	if readyErr != nil {
		c.stop()
		// The class of the failure is the class of the exchange that
		// produced it: an explicit cancellation of the caller stays a
		// cancellation, a deadline of the caller that ended first stays
		// that deadline, and only the internal bound of the client is a
		// bare timeout.
		return readyErr
	}
	// The worker is ready. It still has to answer.
	exchangeDeadline := time.Now().Add(c.config.RequestTimeout)
	exchangeCtx, cancelExchange := context.WithDeadline(ctx, exchangeDeadline)
	probe := readinessRequest()
	line, err := c.buildRequest(probe)
	if err != nil {
		cancelExchange()
		c.stop()
		return err
	}
	_, _, err = c.exchange(exchangeCtx, ctx, exchangeDeadline, line, probe)
	cancelExchange()
	if err != nil {
		// The worker did not answer. It is killed, reaped and reset, so the
		// next probe starts and proves a fresh one. The class of the failure
		// is the class of the exchange that produced it.
		c.stop()
		return err
	}
	return nil
}

// Warm starts the worker and waits until it answers the readiness probe.
//
// The start and the probe have their own budget, so a caller can pay the
// cold start before the first request needs the worker. It is idempotent: a
// worker that is already ready is left alone.
func (c *Client) Warm(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := c.acquire(ctx, time.Now().Add(c.config.StartTimeout)); err != nil {
		return err
	}
	defer c.release()
	if c.closed {
		return ErrClosed
	}
	startDeadline := time.Now().Add(c.config.StartTimeout)
	startCtx, cancel := context.WithDeadline(ctx, startDeadline)
	defer cancel()
	return c.ensureReady(ctx, startCtx, startDeadline)
}

// ensureReady makes sure that a worker process is running and has answered
// the readiness probe.
//
// The probe is a facts-only request for the standard position. Its reply
// proves that the worker booted and speaks the protocol, and the reply is
// discarded. The probe runs under the start budget, so the host's process
// start latency is never charged to the exchange budget of the request that
// waits for the worker.
//
// A probe that fails stops the worker. The next request starts a fresh one;
// the client never retries the probe in a loop.
func (c *Client) ensureReady(ctx context.Context, startCtx context.Context, startDeadline time.Time) error {
	if c.proc != nil && c.ready {
		return nil
	}
	// A canceled caller never starts a worker.
	if err := ctx.Err(); err != nil {
		return callerError(ctx)
	}
	if c.proc == nil {
		if err := c.start(); err != nil {
			return fmt.Errorf("%w: %v", ErrCrashed, err)
		}
	}
	probe := readinessRequest()
	line, err := c.buildRequest(probe)
	if err != nil {
		c.stop()
		return err
	}
	if _, _, err = c.exchange(startCtx, ctx, startDeadline, line, probe); err != nil {
		c.stop()
		return err
	}
	c.ready = true
	return nil
}

// readinessRequest is the facts-only request of the readiness probe.
//
// It asks for the facts of the standard position and expects no candidate.
func readinessRequest() Request {
	return Request{
		RequestID:    ReadinessRequestID,
		MatchVersion: 1,
		FEN:          standardStartingFEN,
		History:      []string{standardStartingFEN},
	}
}

// acquire takes the single worker slot without ignoring the caller's deadline.
// Running out of budget while queued returns immediately and leaves the
// in-flight request and process untouched.
func (c *Client) acquire(ctx context.Context, internal time.Time) error {
	if err := ctx.Err(); err != nil {
		// The context had already ended at the entry of the call. It is
		// classified like the same expiry in the queue: the deadline of the
		// caller when it is the earlier one, and the internal bound
		// otherwise.
		return exchangeError(internal, ctx)
	}
	select {
	case c.slot <- struct{}{}:
		return nil
	default:
	}
	select {
	case c.slot <- struct{}{}:
		return nil
	case <-ctx.Done():
		return exchangeError(internal, ctx)
	}
}

func (c *Client) release() {
	<-c.slot
}

// Close terminates a running worker. It is safe to call more than once.
func (c *Client) Close() error {
	if err := c.acquire(context.Background(), time.Now().Add(c.config.StartTimeout)); err != nil {
		return err
	}
	defer c.release()
	if c.closed {
		return nil
	}
	c.closed = true
	c.stop()
	return nil
}

func (c *Client) buildRequest(request Request) ([]byte, error) {
	if request.RequestID == "" || len(request.RequestID) > MaxRequestIDLength || !requestIDPattern.MatchString(request.RequestID) {
		return nil, fmt.Errorf("%w: requestId must be a bounded correlation token", ErrInvalidRequest)
	}
	if request.MatchVersion < 1 || request.MatchVersion > MaxMatchVersion {
		return nil, fmt.Errorf("%w: matchVersion must be a positive safe integer", ErrInvalidRequest)
	}
	if request.FEN == "" || len(request.FEN) > MaxFENLength || strings.ContainsAny(request.FEN, "\r\n\x00") {
		return nil, fmt.Errorf("%w: fen must be one bounded line", ErrInvalidRequest)
	}
	if len(request.History) < 1 || len(request.History) > MaxHistoryFENs {
		return nil, fmt.Errorf("%w: position history is outside the supported bounds", ErrInvalidRequest)
	}
	for _, entry := range request.History {
		if entry == "" || len(entry) > MaxFENLength || strings.ContainsAny(entry, "\r\n\x00") {
			return nil, fmt.Errorf("%w: position history contains a malformed FEN", ErrInvalidRequest)
		}
	}
	if request.History[len(request.History)-1] != request.FEN {
		return nil, fmt.Errorf("%w: position history must end at the evaluated FEN", ErrInvalidRequest)
	}
	policy := strings.TrimSpace(request.RulesPolicyVersion)
	if policy == "" {
		policy = RulesPolicyVersion
	}

	wire := wireRequest{
		ProtocolVersion:    ProtocolVersion,
		RequestID:          request.RequestID,
		RulesPolicyVersion: policy,
		MatchVersion:       request.MatchVersion,
		FEN:                request.FEN,
		History:            request.History,
	}
	if request.Intent != nil {
		converted, err := convertIntent(*request.Intent)
		if err != nil {
			return nil, err
		}
		wire.Intent = converted
	}
	encoded, err := json.Marshal(wire)
	if err != nil {
		return nil, fmt.Errorf("%w: request could not be encoded", ErrInvalidRequest)
	}
	if len(encoded)+1 > c.config.MaxRequestBytes {
		return nil, fmt.Errorf("%w: request exceeds the worker size limit", ErrInvalidRequest)
	}
	return encoded, nil
}

func convertIntent(intent Intent) (*wireIntent, error) {
	switch intent.Kind {
	case "move":
		if !squarePattern.MatchString(intent.From) || !squarePattern.MatchString(intent.To) {
			return nil, fmt.Errorf("%w: move intent needs board coordinates", ErrInvalidRequest)
		}
		if intent.Promotion != "" && !strings.Contains("qrbn", intent.Promotion) {
			return nil, fmt.Errorf("%w: promotion must be q, r, b, or n", ErrInvalidRequest)
		}
		if intent.ExpiredColor != "" {
			return nil, fmt.Errorf("%w: move intent cannot carry a timeout colour", ErrInvalidRequest)
		}
		return &wireIntent{Kind: "move", From: intent.From, To: intent.To, Promotion: intent.Promotion}, nil
	case "timeout":
		if intent.ExpiredColor != "w" && intent.ExpiredColor != "b" {
			return nil, fmt.Errorf("%w: timeout intent needs a w or b expired colour", ErrInvalidRequest)
		}
		if intent.From != "" || intent.To != "" || intent.Promotion != "" {
			return nil, fmt.Errorf("%w: timeout intent cannot carry a move", ErrInvalidRequest)
		}
		return &wireIntent{Kind: "timeout", ExpiredColor: intent.ExpiredColor}, nil
	default:
		return nil, fmt.Errorf("%w: intent kind must be move or timeout", ErrInvalidRequest)
	}
}

func (c *Client) start() error {
	command := exec.Command(c.config.Node, c.config.Entry)
	command.Env = workerEnvironment(os.Environ())
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	command.Stderr = &boundedBuffer{limit: 4096}
	if err := command.Start(); err != nil {
		_ = stdin.Close()
		return err
	}
	c.proc = command
	c.stdin = stdin
	c.stdout = bufio.NewReaderSize(stdout, 64<<10)
	return nil
}

type readResult struct {
	line []byte
	err  error
}

// exchange performs one bounded write/read round trip. The caller's deadline
// already covers this call; a timeout must terminate the process so a late
// reply can never be read against a newer request.
//
// The caller's context is passed separately, because the class of the failure
// depends on whether the caller's own context ended or the internal budget
// of the exchange did.
func (c *Client) exchange(ctx context.Context, caller context.Context, internal time.Time, line []byte, request Request) (Response, bool, error) {
	writeDone := make(chan error, 1)
	stdin := c.stdin
	go func() {
		_, err := stdin.Write(append(line, '\n'))
		writeDone <- err
	}()
	select {
	case err := <-writeDone:
		if err != nil {
			// A write that failed because the worker died is a crash,
			// unless the caller went away in the same moment: the
			// cancellation of the caller keeps its class.
			if errors.Is(caller.Err(), context.Canceled) {
				return Response{}, false, ErrCanceled
			}
			return Response{}, true, fmt.Errorf("%w: write failed", ErrCrashed)
		}
	case <-ctx.Done():
		c.kill()
		return Response{}, false, exchangeError(internal, caller)
	}

	readDone := make(chan readResult, 1)
	stdout := c.stdout
	go func() {
		payload, err := readLimitedLine(stdout, c.config.MaxResponseBytes)
		readDone <- readResult{line: payload, err: err}
	}()
	select {
	case <-ctx.Done():
		// The exchange ends with the deadline of the caller. A late answer
		// is never read, so it can never be mistaken for the answer of a
		// newer request, and the error keeps the class of the caller's own
		// context: a cancellation stays a cancellation and a deadline stays
		// a timeout.
		c.kill()
		return Response{}, false, exchangeError(internal, caller)
	case result := <-readDone:
		// The answer may have arrived after the deadline of the exchange.
		// A request that ran out of its budget is never answered with a
		// contract outcome, so the budget is checked once more before the
		// answer is accepted.
		if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
			c.kill()
			return Response{}, false, exchangeError(internal, caller)
		}
		if result.err != nil {
			if errors.Is(result.err, errLineTooLong) {
				return Response{}, false, fmt.Errorf("%w: response exceeds the size limit", ErrMalformed)
			}
			if errors.Is(result.err, io.EOF) {
				return Response{}, true, ErrCrashed
			}
			return Response{}, true, fmt.Errorf("%w: %v", ErrCrashed, result.err)
		}
		return c.interpret(result.line, request)
	}
}

func (c *Client) interpret(line []byte, request Request) (Response, bool, error) {
	wire, err := decodeResponse(line)
	if err != nil {
		return Response{}, false, err
	}
	if wire.Status == "rejected" {
		if wire.ProtocolVersion != ProtocolVersion {
			return Response{}, false, fmt.Errorf("%w: rejection protocol version differs", ErrCorrelation)
		}
		if wire.RequestID != nil && *wire.RequestID != request.RequestID {
			return Response{}, false, fmt.Errorf("%w: rejection requestId differs", ErrCorrelation)
		}
		if wire.Code == "" {
			return Response{}, false, fmt.Errorf("%w: rejection has no code", ErrMalformed)
		}
		message := wire.Message
		if len(message) > 240 {
			message = message[:240]
		}
		return Response{}, false, &RejectionError{Code: wire.Code, Message: message}
	}
	if wire.Status != "ok" {
		return Response{}, false, fmt.Errorf("%w: unknown response status", ErrMalformed)
	}
	response, err := validateResponse(wire, request)
	if err != nil {
		return Response{}, false, err
	}
	return response, false, nil
}

func decodeResponse(line []byte) (*wireResponse, error) {
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	var wire wireResponse
	if err := decoder.Decode(&wire); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: trailing response data", ErrMalformed)
	}
	return &wire, nil
}

func validateResponse(wire *wireResponse, request Request) (Response, error) {
	correlation := func(message string) (Response, error) {
		return Response{}, fmt.Errorf("%w: %s", ErrCorrelation, message)
	}
	if wire.ProtocolVersion != ProtocolVersion {
		return correlation("protocol version differs")
	}
	if wire.RequestID == nil || *wire.RequestID != request.RequestID {
		return correlation("requestId differs")
	}
	if wire.MatchVersion != request.MatchVersion {
		return correlation("match version differs")
	}
	if wire.RulesPolicyVersion != policyFor(request) {
		return correlation("rules policy version differs")
	}
	if !fingerprintShape.MatchString(wire.InputFingerprint) {
		return correlation("input fingerprint is malformed")
	}
	expectedFingerprint, err := semanticInputFingerprint(request)
	if err != nil {
		return Response{}, err
	}
	if wire.InputFingerprint != expectedFingerprint {
		return correlation("input fingerprint does not match the request")
	}
	if wire.Engine.Name != EngineName || wire.Engine.Version != EngineVersion {
		return correlation("rules engine version differs")
	}
	if wire.Input.FEN != request.FEN {
		return correlation("input FEN differs")
	}
	if wire.Input.Identity == "" || len(wire.Input.Identity) > MaxFENLength {
		return Response{}, fmt.Errorf("%w: input identity is malformed", ErrMalformed)
	}
	if wire.Facts == nil {
		return Response{}, fmt.Errorf("%w: facts are missing", ErrMalformed)
	}
	if err := validateFacts(*wire.Facts); err != nil {
		return Response{}, err
	}
	if wire.Facts.RepetitionCount != wire.Input.RepetitionCount {
		return Response{}, fmt.Errorf("%w: repetition count differs from input", ErrMalformed)
	}
	if err := validateIntentOutcome(request.Intent, wire.Facts, wire.Candidate); err != nil {
		return Response{}, err
	}
	if wire.Candidate != nil {
		if err := validateCandidate(*wire.Candidate); err != nil {
			return Response{}, err
		}
	}
	return Response{
		ProtocolVersion:    wire.ProtocolVersion,
		RequestID:          *wire.RequestID,
		MatchVersion:       wire.MatchVersion,
		RulesPolicyVersion: wire.RulesPolicyVersion,
		InputFingerprint:   wire.InputFingerprint,
		Engine:             wire.Engine,
		Input:              wire.Input,
		Facts:              *wire.Facts,
		Candidate:          wire.Candidate,
	}, nil
}

func policyFor(request Request) string {
	if policy := strings.TrimSpace(request.RulesPolicyVersion); policy != "" {
		return policy
	}
	return RulesPolicyVersion
}

// validateIntentOutcome keeps a timeout or evaluate-only reply from carrying a
// move candidate, and requires a move candidate for a move request.
func validateIntentOutcome(intent *Intent, facts *Facts, candidate *Candidate) error {
	if intent == nil {
		if candidate != nil || facts.TimeoutWinner != nil {
			return fmt.Errorf("%w: evaluate-only response carried a terminal outcome", ErrMalformed)
		}
		return nil
	}
	switch intent.Kind {
	case "move":
		if candidate == nil {
			return fmt.Errorf("%w: move response has no candidate", ErrMalformed)
		}
		if candidate.Move.From != intent.From || candidate.Move.To != intent.To || candidate.Move.Promotion != intent.Promotion {
			return fmt.Errorf("%w: candidate move differs from the request", ErrCorrelation)
		}
		if facts.TimeoutWinner != nil {
			return fmt.Errorf("%w: move response carried a timeout winner", ErrMalformed)
		}
	case "timeout":
		if candidate != nil {
			return fmt.Errorf("%w: timeout response carried a move candidate", ErrMalformed)
		}
		if facts.TimeoutWinner == nil {
			return fmt.Errorf("%w: timeout response has no winner", ErrMalformed)
		}
	default:
		return fmt.Errorf("%w: unknown intent kind", ErrInvalidRequest)
	}
	return nil
}

func validateFacts(facts Facts) error {
	if !endingPattern.MatchString(facts.Ending) {
		return fmt.Errorf("%w: unknown ending", ErrMalformed)
	}
	if facts.Deadness != "not-assessed" {
		return fmt.Errorf("%w: unknown deadness value", ErrMalformed)
	}
	if !occurrencesPattern.MatchString(facts.RepetitionCount) {
		return fmt.Errorf("%w: repetition count is malformed", ErrMalformed)
	}
	if !validMaterial(facts.Material) {
		return fmt.Errorf("%w: material counts are malformed", ErrMalformed)
	}
	if facts.TimeoutWinner != nil && !timeoutWinnerPattern.MatchString(*facts.TimeoutWinner) {
		return fmt.Errorf("%w: timeout winner is unknown", ErrMalformed)
	}
	return nil
}

func validMaterial(material Material) bool {
	valid := func(counts PieceCounts) bool {
		return counts.Pawns >= 0 && counts.Knights >= 0 && counts.Bishops >= 0 &&
			counts.Rooks >= 0 && counts.Queens >= 0 && counts.Kings >= 0
	}
	return material.Total >= 0 && valid(material.White) && valid(material.Black)
}

func validateCandidate(candidate Candidate) error {
	if !squarePattern.MatchString(candidate.Move.From) || !squarePattern.MatchString(candidate.Move.To) {
		return fmt.Errorf("%w: candidate move coordinates are malformed", ErrMalformed)
	}
	if candidate.Move.Promotion != "" && !strings.Contains("qrbn", candidate.Move.Promotion) {
		return fmt.Errorf("%w: candidate promotion is malformed", ErrMalformed)
	}
	if candidate.SAN == "" || len(candidate.SAN) > 32 {
		return fmt.Errorf("%w: candidate SAN is missing or too long", ErrMalformed)
	}
	if candidate.ResultingFEN == "" || len(candidate.ResultingFEN) > MaxFENLength || strings.ContainsAny(candidate.ResultingFEN, "\r\n\x00") {
		return fmt.Errorf("%w: candidate FEN is malformed", ErrMalformed)
	}
	if err := validateFacts(candidate.Ending); err != nil {
		return err
	}
	if candidate.Ending.TimeoutWinner != nil {
		return fmt.Errorf("%w: move candidate cannot carry a timeout winner", ErrMalformed)
	}
	if candidate.Repetition.Version != 1 || len(candidate.Repetition.Entries) < 1 || len(candidate.Repetition.Entries) > MaxLedgerEntries {
		return fmt.Errorf("%w: candidate repetition history is outside the supported bounds", ErrMalformed)
	}
	for _, entry := range candidate.Repetition.Entries {
		if entry.Identity == "" || len(entry.Identity) > MaxFENLength || !occurrencesPattern.MatchString(entry.Occurrences) {
			return fmt.Errorf("%w: candidate repetition entry is malformed", ErrMalformed)
		}
	}
	return nil
}

var (
	requestIDPattern     = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)
	squarePattern        = regexp.MustCompile(`^[a-h][1-8]$`)
	occurrencesPattern   = regexp.MustCompile(`^[1-9][0-9]*$`)
	fingerprintShape     = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	endingPattern        = regexp.MustCompile(`^(checkmate|stalemate|insufficient-material|threefold-repetition|hundred-halfmoves|none)$`)
	timeoutWinnerPattern = regexp.MustCompile(`^(white|black|draw)$`)
)

var errLineTooLong = errors.New("rules worker line exceeds the size limit")

func readLimitedLine(reader *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(line)+len(fragment) > limit {
			return nil, errLineTooLong
		}
		line = append(line, fragment...)
		if err == nil {
			return bytes.TrimSpace(line), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			return line, io.EOF
		}
		return nil, err
	}
}

func (c *Client) kill() {
	if c.proc != nil && c.proc.Process != nil {
		_ = c.proc.Process.Kill()
	}
}

func (c *Client) stop() {
	if c.proc == nil {
		c.ready = false
		return
	}
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	_ = c.proc.Process.Kill()
	_ = c.proc.Wait()
	c.proc = nil
	c.stdin = nil
	c.stdout = nil
	c.ready = false
}

// exchangeError maps the end of an exchange onto the class of the failure.
//
// The internal deadline of the phase is passed **explicitly**, because a
// derived context clamps its own deadline to the earlier of the requested
// deadline and the deadline of its parent. The class of a failure must not
// be read from that clamped value: when the deadline of the caller ends
// first, the derived deadline equals the deadline of the caller, and the
// internal budget would look like the one that ended the exchange.
//
//   - An explicit cancellation of the caller is a cancellation. The caller
//     knows that it went away.
//   - The deadline of the caller, when it is strictly earlier than the
//     internal deadline, ended the exchange, and the cause is carried.
//   - Otherwise the internal budget ended it, and it carries **no** cause.
//     A worker that did not answer inside its own budget is an outage of the
//     worker, and it must never be recorded as the deadline of a caller.
//
// At the boundary the two deadlines are equal, and the internal budget wins:
// the worker had its whole budget, and the caller had no more than that.
func exchangeError(internal time.Time, caller context.Context) error {
	if caller == nil {
		return ErrTimeout
	}
	if errors.Is(caller.Err(), context.Canceled) {
		return ErrCanceled
	}
	if deadline, ok := caller.Deadline(); ok && deadline.Before(internal) && caller.Err() != nil {
		return fmt.Errorf("%w: %w", ErrTimeout, context.DeadlineExceeded)
	}
	return ErrTimeout
}

// callerError maps the end of the caller's own context.
//
// It is used where the context that ended is the caller's own: a canceled
// caller is a cancellation, and a deadline that the caller set is carried as
// the cause.
func callerError(caller context.Context) error {
	if caller == nil {
		return ErrTimeout
	}
	if errors.Is(caller.Err(), context.Canceled) {
		return ErrCanceled
	}
	if errors.Is(caller.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("%w: %w", ErrTimeout, context.DeadlineExceeded)
	}
	return ErrTimeout
}

type boundedBuffer struct {
	mu    sync.Mutex
	data  []byte
	limit int
}

func (b *boundedBuffer) Write(payload []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if remaining := b.limit - len(b.data); remaining > 0 {
		if len(payload) <= remaining {
			b.data = append(b.data, payload...)
		} else {
			b.data = append(b.data, payload[:remaining]...)
		}
	}
	return len(payload), nil
}

func workerEnvironment(environ []string) []string {
	allowed := map[string]bool{
		"PATH": true, "PATHEXT": true, "SYSTEMROOT": true, "SYSTEMDRIVE": true,
		"WINDIR": true, "COMSPEC": true, "TEMP": true, "TMP": true, "TMPDIR": true,
		"LANG": true, "LC_ALL": true,
	}
	result := make([]string, 0, len(environ)+2)
	for _, entry := range environ {
		key := entry
		if index := strings.IndexByte(entry, '='); index >= 0 {
			key = entry[:index]
		}
		if allowed[strings.ToUpper(key)] {
			result = append(result, entry)
		}
	}
	return append(result, "NODE_ENV=production", "NODE_NO_WARNINGS=1")
}
