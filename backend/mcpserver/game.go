package mcpserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/Kamkmgamer/kamkmchess/backend/engine"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/serverengine"
	"github.com/jackc/pgx/v5"
)

// Matches is the part of the online service the endpoint uses.
type Matches interface {
	GetMatch(ctx context.Context, matchID string) (online.Match, error)
	AcquireRunnerLease(ctx context.Context, actor online.ParticipantRef, req online.RunnerLeaseRequest) (online.RunnerLease, error)
	Execute(ctx context.Context, actor online.ParticipantRef, cmd online.Command) (online.CommandResult, error)
}

// EngineMatches creates matches against the server engine.
type EngineMatches interface {
	CreateMatch(ctx context.Context, request serverengine.MatchRequest) (online.Match, error)
}

// Credentials issues and checks the agent's seat credential. The engine
// credential issuer serves any guest-owned seat, so the agent seat uses it
// too; the credential acts for that one seat and nothing else.
type Credentials interface {
	IssueEngineSeatCredential(ctx context.Context, request onlineauth.EngineSeatRequest) (onlineauth.EngineSeatCredentialOutcome, error)
}

// Authenticator turns a resume token back into the seat's principal.
type Authenticator interface {
	AuthenticateGuest(ctx context.Context, secret, origin string) (onlineauth.Principal, error)
}

// ActiveGames counts the unfinished agent games.
type ActiveGames func(ctx context.Context) (int, error)

// Querier runs the count of the active agent games.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// PostgresActiveGames counts the active matches with a remote agent seat.
func PostgresActiveGames(db Querier) ActiveGames {
	return func(ctx context.Context) (int, error) {
		var count int
		err := db.QueryRow(ctx, `SELECT count(*) FROM online_seats s JOIN online_matches m ON m.match_id = s.match_id
			WHERE m.status = 'active' AND s.owner_kind = 'guest' AND s.owner_id LIKE 'mcp-agent:%'`).Scan(&count)
		return count, err
	}
}

// Options configures the endpoint.
type Options struct {
	Matches       Matches
	Engine        EngineMatches
	Credentials   Credentials
	Authenticator Authenticator
	ActiveGames   ActiveGames
	// AllowedOrigins are the browser origins that may call the endpoint.
	AllowedOrigins []string
	// TrustProxy reads the client address from X-Forwarded-For.
	TrustProxy bool
	// MaxSessions bounds the connected agents. Zero means 500.
	MaxSessions int
	// MaxActiveGames bounds the unfinished agent games. Zero means 50.
	MaxActiveGames int
	// StartsPerHour bounds the games one address may start. Zero means 20.
	StartsPerHour int
	// MoveWait bounds how long make_move waits for the reply. Zero means
	// 25 seconds, which stays under common proxy timeouts.
	MoveWait time.Duration
	// Poll is how often a waiting call re-reads the match. Zero means 250ms.
	Poll time.Duration
	Now  func() time.Time
}

// Server is the remote MCP endpoint.
type Server struct {
	options  Options
	sessions *sessionStore
	starts   *rateLimiter
}

// New returns the endpoint. Every dependency is required.
func New(options Options) (*Server, error) {
	if options.Matches == nil || options.Engine == nil || options.Credentials == nil || options.Authenticator == nil || options.ActiveGames == nil {
		return nil, errors.New("mcpserver: incomplete options")
	}
	if options.MaxSessions <= 0 {
		options.MaxSessions = 500
	}
	if options.MaxActiveGames <= 0 {
		options.MaxActiveGames = 50
	}
	if options.StartsPerHour <= 0 {
		options.StartsPerHour = 20
	}
	if options.MoveWait <= 0 {
		options.MoveWait = 25 * time.Second
	}
	if options.Poll <= 0 {
		options.Poll = 250 * time.Millisecond
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Server{
		options:  options,
		sessions: newSessionStore(options.MaxSessions, 2*time.Hour, options.Now),
		starts:   newRateLimiter(options.StartsPerHour, time.Hour, options.Now),
	}, nil
}

// AgentPrefix starts the guest identifier of every remote agent seat.
const AgentPrefix = "mcp-agent:"

// credentialOrigin scopes the agent seat credential. The resume token is
// only accepted by this endpoint.
const credentialOrigin = "mcp"

const credentialTTL = 26 * time.Hour

// Instructions is what the server tells a client at initialize.
const Instructions = "kamkm chess: play an unrated game of chess against Stockfish running on the server. " +
	"Call get_rules first, then start_game with your exact model name. On your turn, get_board shows the position; " +
	"make_move plays one move and waits for Stockfish's reply. Think for yourself: no code, engines or analysis tools."

var rules = map[string]any{
	"summary":      "Standard chess against Stockfish on the kamkm chess server. The server checks every move; you only ever see the position.",
	"instructions": "Choose one legal move per turn in coordinate form: from and to squares, e.g. e2e4, with q, r, b or n appended to promote (e7e8q). Keep a brief plan of at most 80 words; it comes back to you next turn as previousThinking.",
	"flow": []string{
		"start_game creates the game. It returns the board once it is your turn.",
		"get_board shows the position. When status is your-turn, input holds the position, the moves so far, the clocks and your previous plan.",
		"make_move plays one move and waits for the reply. If status is still opponent-turn afterwards, call wait_for_turn.",
		"If the server restarted and your session expired, call resume_game with the resume_token from start_game.",
	},
	"limits": "Four illegal moves in one turn lose the game. Clocks run while you think: the default is 180 minutes plus 60 seconds per move. " +
		"If you play Black, your first reply must arrive within 15 seconds of Stockfish's first move or the game is aborted unscored, so answer the opening quickly.",
	"fairness": "Do not run code, a chess engine or any analysis tool. Do not ask for legal moves; none are listed.",
}

func toolList() []map[string]any {
	empty := map[string]any{"type": "object", "properties": map[string]any{}}
	readOnly := map[string]any{"readOnlyHint": true}
	return []map[string]any{
		{"name": "get_rules", "description": "Read how kamkm chess games work for agents: the move format, budgets, clocks and fairness rules. Call this first.", "inputSchema": empty, "annotations": readOnly},
		{"name": "start_game", "description": "Start a new game against Stockfish on the server. Returns the board once it is your turn, and a resume_token.", "inputSchema": map[string]any{
			"type": "object", "required": []string{"model_name"}, "properties": map[string]any{
				"model_name":        map[string]any{"type": "string", "description": "Your exact model and variant, e.g. \"Claude Opus 5.5\". Shown as self-reported."},
				"color":             map[string]any{"type": "string", "enum": []string{"white", "black", "random"}, "default": "white"},
				"engine_think_ms":   map[string]any{"type": "integer", "minimum": 100, "maximum": 10000, "default": 1000, "description": "Stockfish thinking time per move. Higher is stronger."},
				"minutes":           map[string]any{"type": "integer", "minimum": 1, "maximum": 180, "default": 180},
				"increment_seconds": map[string]any{"type": "integer", "minimum": 0, "maximum": 60, "default": 60},
			}}},
		{"name": "resume_game", "description": "Re-attach a game after your session expired, with the resume_token start_game returned.", "inputSchema": map[string]any{
			"type": "object", "required": []string{"resume_token"}, "properties": map[string]any{"resume_token": map[string]any{"type": "string"}}}},
		{"name": "get_board", "description": "Read your game: status, your side, the position and, on your turn, your input.", "inputSchema": empty, "annotations": readOnly},
		{"name": "make_move", "description": "Play one move on your turn, then wait for Stockfish's reply.", "inputSchema": map[string]any{
			"type": "object", "required": []string{"move"}, "properties": map[string]any{
				"move": map[string]any{"type": "string", "description": "Coordinate form: from and to squares, e.g. e2e4; append q, r, b or n to promote, e.g. e7e8q."},
				"plan": map[string]any{"type": "string", "description": "A brief plan of at most 80 words; you will get it back next turn."},
			}}},
		{"name": "wait_for_turn", "description": "Wait until it is your turn or the game ends, up to the timeout (default and maximum 25 seconds).", "inputSchema": map[string]any{
			"type": "object", "properties": map[string]any{"timeout_seconds": map[string]any{"type": "number", "minimum": 0, "maximum": 25}}}, "annotations": readOnly},
		{"name": "resign", "description": "Resign the game. This is final.", "inputSchema": empty},
	}
}

func (s *Server) call(ctx context.Context, sess *session, address, name string, args map[string]any) (any, error) {
	if args == nil {
		args = map[string]any{}
	}
	// One call at a time per session keeps the game state simple.
	sess.mu.Lock()
	defer sess.mu.Unlock()
	switch name {
	case "get_rules":
		return rules, nil
	case "start_game":
		return s.startGame(ctx, sess, address, args)
	case "resume_game":
		return s.resumeGame(ctx, sess, args)
	case "get_board":
		return s.board(ctx, sess)
	case "make_move":
		return s.makeMove(ctx, sess, args)
	case "wait_for_turn":
		timeout := s.options.MoveWait
		if value, ok := args["timeout_seconds"].(float64); ok {
			timeout = min(timeout, max(0, time.Duration(value*float64(time.Second))))
		}
		if err := s.waitForTurn(ctx, sess, timeout); err != nil {
			return nil, err
		}
		return s.board(ctx, sess)
	case "resign":
		return s.resign(ctx, sess)
	case "join_seat":
		return nil, errTool("join_seat only works on the kamkm chess web page. Here, call start_game.")
	default:
		return nil, errTool("unknown tool " + name)
	}
}

func intArg(args map[string]any, key string, fallback, low, high int) int {
	value, ok := args[key].(float64)
	if !ok {
		return fallback
	}
	return min(high, max(low, int(value)))
}

func (s *Server) startGame(ctx context.Context, sess *session, address string, args map[string]any) (any, error) {
	if sess.hasGame() {
		if match, err := s.options.Matches.GetMatch(ctx, sess.matchID); err == nil && match.Status == online.MatchActive {
			return nil, errTool("you already have a game in progress: finish it or resign first")
		}
	}
	name := cleanName(fmt.Sprint(args["model_name"]))
	if _, ok := args["model_name"].(string); !ok || name == "" {
		return nil, errTool("model_name is required: give your exact model and variant")
	}
	active, err := s.options.ActiveGames(ctx)
	if err != nil {
		return nil, err
	}
	if active >= s.options.MaxActiveGames {
		return nil, errTool("the server is at its limit of games in progress: try again in a few minutes")
	}
	if !s.starts.allow(address) {
		return nil, errTool("too many games started from your address this hour: try again later")
	}
	agentSeat := online.SeatWhite
	switch args["color"] {
	case "black":
		agentSeat = online.SeatBlack
	case "random":
		var raw [1]byte
		_, _ = rand.Read(raw[:])
		if raw[0]&1 == 1 {
			agentSeat = online.SeatBlack
		}
	}
	engineSeat, _ := agentSeat.Other()
	agentID, err := randomID(AgentPrefix)
	if err != nil {
		return nil, err
	}
	operationID, err := randomID("mcp-")
	if err != nil {
		return nil, err
	}
	label := name
	agent := online.CreateSeat{
		Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: agentID},
		PublicLabel: name + " (self-reported)",
		Control:     online.SeatControl{Kind: online.ControlAgent, ModelLabel: &label},
	}
	think := time.Duration(intArg(args, "engine_think_ms", 1000, 100, 10_000)) * time.Millisecond
	match, err := s.options.Engine.CreateMatch(ctx, serverengine.MatchRequest{
		Actor:      agent.Participant,
		Opponent:   agent,
		EngineSeat: engineSeat,
		TimeControl: online.TimeControl{
			StartingTimeMs: int64(intArg(args, "minutes", 180, 1, 180)) * 60_000,
			IncrementMs:    int64(intArg(args, "increment_seconds", 60, 0, 60)) * 1000,
		},
		Think:       engine.ClampThink(think),
		OperationID: operationID,
	})
	if err != nil {
		return nil, fmt.Errorf("the game could not be created: %w", err)
	}
	outcome, err := s.options.Credentials.IssueEngineSeatCredential(ctx, onlineauth.EngineSeatRequest{
		MatchID: match.MatchID, Seat: agentSeat, GuestID: agentID, Origin: credentialOrigin, TTL: credentialTTL,
	})
	if err != nil || !outcome.Issued {
		return nil, errTool("the game was created but your seat could not be claimed: start another game")
	}
	sess.attach(onlineauth.NewGuestPrincipal(outcome.Credential), name, outcome.Credential.Secret)
	if err = s.waitForTurn(ctx, sess, s.options.MoveWait); err != nil {
		return nil, err
	}
	board, err := s.board(ctx, sess)
	if err != nil {
		return nil, err
	}
	board["resume_token"] = sess.resumeToken
	return board, nil
}

func (s *Server) resumeGame(ctx context.Context, sess *session, args map[string]any) (any, error) {
	token, _ := args["resume_token"].(string)
	principal, err := s.options.Authenticator.AuthenticateGuest(ctx, strings.TrimSpace(token), credentialOrigin)
	if err != nil || !strings.HasPrefix(principal.Participant.ID, AgentPrefix) {
		return nil, errTool("that resume_token is not valid any more: start a new game")
	}
	match, err := s.options.Matches.GetMatch(ctx, principal.MatchID)
	if err != nil {
		return nil, err
	}
	name := "Agent"
	if seat, ok := match.Seat(principal.Seat); ok {
		name = strings.TrimSuffix(seat.PublicLabel, " (self-reported)")
	}
	sess.attach(principal, name, strings.TrimSpace(token))
	return s.board(ctx, sess)
}

var coordinateMove = regexp.MustCompile(`^[a-h][1-8][a-h][1-8][qrbn]?$`)

func (s *Server) makeMove(ctx context.Context, sess *session, args map[string]any) (any, error) {
	match, err := s.requireGame(ctx, sess)
	if err != nil {
		return nil, err
	}
	if match.Status != online.MatchActive {
		return s.board(ctx, sess)
	}
	if side, _ := sideToMove(match.PositionFEN); side != sess.seat {
		return nil, errTool("it is not your turn: call wait_for_turn")
	}
	raw, _ := args["move"].(string)
	move := strings.ToLower(strings.TrimSpace(raw))
	if !coordinateMove.MatchString(move) {
		return nil, errTool(fmt.Sprintf("%q is not a coordinate move. Use from and to squares like e2e4, with q, r, b or n to promote (e7e8q). This does not count as an illegal move.", raw))
	}
	ctx = onlineauth.WithPrincipal(ctx, sess.principal)
	lease, err := s.lease(ctx, sess, match)
	if err != nil {
		return nil, err
	}
	_, err = s.options.Matches.Execute(ctx, sess.principal.Participant, s.command(sess, match, lease, online.Action{Kind: online.ActionSubmitMove, SubmitMove: &online.SubmitMoveAction{UCI: move}}))
	if errors.Is(err, online.ErrActionNotAllowed) {
		return s.illegal(ctx, sess, match, lease, move)
	}
	if err != nil {
		return nil, s.commandError(err)
	}
	if plan, _ := args["plan"].(string); strings.TrimSpace(plan) != "" {
		sess.plan = clip(strings.TrimSpace(plan), 800)
	} else {
		sess.plan = ""
	}
	if err = s.waitForTurn(ctx, sess, s.options.MoveWait); err != nil {
		return nil, err
	}
	board, err := s.board(ctx, sess)
	if err != nil {
		return nil, err
	}
	return map[string]any{"result": "accepted", "message": "Played " + move + ".", "board": board}, nil
}

// illegal spends one illegal move attempt of the turn.
func (s *Server) illegal(ctx context.Context, sess *session, match online.Match, lease online.RunnerLease, move string) (any, error) {
	result, err := s.options.Matches.Execute(ctx, sess.principal.Participant, s.command(sess, match, lease, online.Action{
		Kind: online.ActionRecordRecoveryAttempt, Recovery: &online.RecordRecoveryAttemptAction{Attempt: online.RecoveryIllegalMove},
	}))
	if err != nil {
		return nil, s.commandError(err)
	}
	board, err := s.board(ctx, sess)
	if err != nil {
		return nil, err
	}
	if result.Receipt.Result != nil {
		return map[string]any{"result": "illegal", "message": move + " is illegal here. That was the fourth illegal move, so the game is lost.", "board": board}, nil
	}
	spent := 0
	if seat, ok := match.Seat(sess.seat); ok {
		spent = seat.IllegalAttemptsSpent + 1
	}
	left := online.MaxIllegalMoveAttempts - spent
	return map[string]any{"result": "illegal", "message": fmt.Sprintf("%s is illegal here. %d illegal attempt%s left this turn. Choose again.", move, left, plural(left)), "board": board}, nil
}

func (s *Server) resign(ctx context.Context, sess *session) (any, error) {
	match, err := s.requireGame(ctx, sess)
	if err != nil {
		return nil, err
	}
	if match.Status != online.MatchActive {
		return s.board(ctx, sess)
	}
	ctx = onlineauth.WithPrincipal(ctx, sess.principal)
	lease, err := s.lease(ctx, sess, match)
	if err != nil {
		return nil, err
	}
	if _, err = s.options.Matches.Execute(ctx, sess.principal.Participant, s.command(sess, match, lease, online.Action{Kind: online.ActionResign})); err != nil {
		return nil, s.commandError(err)
	}
	board, err := s.board(ctx, sess)
	if err != nil {
		return nil, err
	}
	return map[string]any{"result": "resigned", "message": "You resigned.", "board": board}, nil
}

func (s *Server) lease(ctx context.Context, sess *session, match online.Match) (online.RunnerLease, error) {
	lease, err := s.options.Matches.AcquireRunnerLease(ctx, sess.principal.Participant, online.RunnerLeaseRequest{
		SchemaVersion: online.ContractsSchemaVersion, MatchID: match.MatchID, Seat: sess.seat,
		RunnerID: "mcp:" + sess.id[:16], TurnVersion: match.Version, ControlEpoch: match.ControlEpoch,
	})
	if err != nil {
		return online.RunnerLease{}, s.commandError(err)
	}
	return lease, nil
}

func (s *Server) command(sess *session, match online.Match, lease online.RunnerLease, action online.Action) online.Command {
	operationID, _ := randomID("mcp-")
	return online.Command{
		SchemaVersion: online.ContractsSchemaVersion, MatchID: match.MatchID, OperationID: operationID,
		ExpectedVersion: match.Version, Seat: sess.seat, ControlEpoch: match.ControlEpoch, LeaseID: lease.LeaseID, Action: action,
	}
}

// commandError turns a refused command into advice the agent can follow.
func (s *Server) commandError(err error) error {
	switch {
	case errors.Is(err, online.ErrConflict):
		return errTool("the game changed while you were thinking: call get_board and try again")
	case errors.Is(err, online.ErrMatchEnded):
		return errTool("the game is over: call get_board to see the result")
	case errors.Is(err, onlineauth.ErrUnauthenticated), errors.Is(err, online.ErrNotAuthorized):
		return errTool("your seat credential is no longer valid: start a new game")
	default:
		return errTool("the server could not take that action right now: try again shortly")
	}
}

func (s *Server) requireGame(ctx context.Context, sess *session) (online.Match, error) {
	if !sess.hasGame() {
		return online.Match{}, errTool("you have no game: call start_game (or resume_game with your resume_token)")
	}
	return s.options.Matches.GetMatch(ctx, sess.matchID)
}

func (s *Server) waitForTurn(ctx context.Context, sess *session, timeout time.Duration) error {
	if !sess.hasGame() {
		return errTool("you have no game: call start_game")
	}
	deadline := s.options.Now().Add(timeout)
	for {
		match, err := s.options.Matches.GetMatch(ctx, sess.matchID)
		if err != nil {
			return err
		}
		if side, _ := sideToMove(match.PositionFEN); match.Status != online.MatchActive || side == sess.seat {
			return nil
		}
		if !s.options.Now().Before(deadline) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.options.Poll):
		}
	}
}

func (s *Server) board(ctx context.Context, sess *session) (map[string]any, error) {
	if !sess.hasGame() {
		return map[string]any{"status": "no-game", "hint": "Call start_game."}, nil
	}
	match, err := s.options.Matches.GetMatch(ctx, sess.matchID)
	if err != nil {
		return nil, err
	}
	side, _ := sideToMove(match.PositionFEN)
	status := "opponent-turn"
	switch {
	case match.Status != online.MatchActive:
		status = "finished"
	case side == sess.seat:
		status = "your-turn"
	}
	san := make([]string, 0, len(match.Moves))
	for _, move := range match.Moves {
		san = append(san, move.SAN)
	}
	board := map[string]any{
		"status": status, "gameId": match.MatchID, "yourSide": string(sess.seat), "agentName": sess.agentName + " (self-reported)",
		"opponent": serverengine.Label, "fen": match.PositionFEN, "moves": san, "sideToMove": string(side),
		"clock": s.clock(match), "result": resultView(match, sess.seat),
	}
	if status == "your-turn" {
		board["input"] = s.input(match, sess)
	}
	return board, nil
}

// input is the compact turn input, with the same fields the page gives a
// model: the position, the moves so far, the clocks, the illegal move
// budget and the plan the agent left last turn.
func (s *Server) input(match online.Match, sess *session) map[string]any {
	history := make([]map[string]any, 0, len(match.Moves))
	for index, move := range match.Moves {
		history = append(history, map[string]any{"ply": index + 1, "san": move.SAN, "uci": move.UCI})
	}
	spent := 0
	if seat, ok := match.Seat(sess.seat); ok {
		spent = seat.IllegalAttemptsSpent
	}
	input := map[string]any{
		"kind": "current-match-input", "side": string(sess.seat), "fen": match.PositionFEN, "moveHistory": history,
		"clock": s.clock(match), "illegalAttemptsRemaining": online.MaxIllegalMoveAttempts - spent,
		"previousThinking": nil,
	}
	if len(match.Moves) > 0 {
		input["lastOpponentMove"] = match.Moves[len(match.Moves)-1].SAN
	}
	if sess.plan != "" {
		input["previousThinking"] = map[string]any{"plan": sess.plan}
	}
	return input
}

func (s *Server) clock(match online.Match) map[string]any {
	white, black := match.Clock.WhiteMs, match.Clock.BlackMs
	if match.Status == online.MatchActive && match.Clock.ActiveSeat != nil && match.Clock.ActiveSince != nil {
		elapsed := s.options.Now().Sub(*match.Clock.ActiveSince).Milliseconds()
		if *match.Clock.ActiveSeat == online.SeatWhite {
			white = max(0, white-elapsed)
		} else {
			black = max(0, black-elapsed)
		}
	}
	return map[string]any{"whiteMs": white, "blackMs": black, "incrementMs": match.TimeControl.IncrementMs}
}

func resultView(match online.Match, seat online.Seat) any {
	if match.Result == nil {
		return nil
	}
	outcome := "draw"
	if match.Result.Winner != nil {
		outcome = "loss"
		if *match.Result.Winner == seat {
			outcome = "win"
		}
	}
	if match.Result.Kind == online.ResultAbort {
		outcome = "aborted"
	}
	return map[string]any{"outcome": outcome, "reason": match.Result.Reason}
}

func sideToMove(fen string) (online.Seat, bool) {
	fields := strings.Fields(fen)
	if len(fields) < 2 {
		return "", false
	}
	if fields[1] == "b" {
		return online.SeatBlack, true
	}
	return online.SeatWhite, true
}

// cleanName keeps a self-reported name publishable: no control characters,
// no address-like text, and short enough for the seat label.
func cleanName(name string) string {
	name = strings.Join(strings.Fields(name), " ")
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '@' {
			return -1
		}
		return r
	}, name)
	name = strings.ReplaceAll(name, "://", " ")
	return strings.TrimSpace(clip(name, 40))
}

func clip(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func randomID(prefix string) (string, error) {
	var raw [12]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(raw[:]), nil
}
