// Package agentboards keeps the record of remote agent games and serves the
// verified, community and browser boards.
//
// A game is verified only when it was started with an invite code an
// operator issued for the official runner. Every other MCP game is a
// community result under a self-reported name. A browser result is the
// weakest record: the visitor's own device played and scored the game and
// nothing on the server checked it.
package agentboards

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/agentname"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The names of the boards Read serves.
const (
	BoardVerified  = "verified"
	BoardCommunity = "community"
	BoardBrowser   = "browser"
)

// ReasoningEfforts are the reasoning levels an agent may report for itself.
var ReasoningEfforts = map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true, "max": true}

// results are the outcomes a browser report may claim, from the model's
// own perspective.
var results = map[string]bool{"win": true, "draw": true, "loss": true}

// ErrInvalidReport reports a browser result the validation rejects.
var ErrInvalidReport = errors.New("agentboards: the reported game is not valid")

// Store reads and writes the agent game records.
type Store struct {
	db *pgxpool.Pool
}

// New returns a store on the pool.
func New(db *pgxpool.Pool) *Store { return &Store{db: db} }

// Game is one recorded agent game.
type Game struct {
	MatchID         string
	AgentSeat       string
	ModelName       string
	ReasoningEffort string
	EngineThinkMs   int
	Runner          string
}

const codePrefix = "kinv_"

func hashCode(code string) []byte {
	sum := sha256.Sum256([]byte("kamkmchess/agent-invite/" + strings.TrimSpace(code)))
	return sum[:]
}

// InviteValid reports whether a code can still start a verified game. It
// does not spend a use.
func (s *Store) InviteValid(ctx context.Context, code string) (bool, error) {
	if !strings.HasPrefix(strings.TrimSpace(code), codePrefix) {
		return false, nil
	}
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM online_agent_invites WHERE code_hash=$1 AND revoked_at IS NULL AND uses_left > 0)`, hashCode(code)).Scan(&ok)
	return ok, err
}

// Record stores a game. With a code it spends one use of the invite in the
// same transaction and marks the game verified; a code that ran out in the
// meantime leaves the game on the community board.
func (s *Store) Record(ctx context.Context, game Game, code string) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var inviteID *string
	if strings.TrimSpace(code) != "" {
		var id string
		err = tx.QueryRow(ctx, `UPDATE online_agent_invites SET uses_left = uses_left - 1 WHERE code_hash=$1 AND revoked_at IS NULL AND uses_left > 0 RETURNING invite_id`, hashCode(code)).Scan(&id)
		if err == nil {
			inviteID = &id
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
	}
	var runner *string
	if value := strings.TrimSpace(game.Runner); value != "" {
		runner = &value
	}
	var effort any
	if value := strings.TrimSpace(game.ReasoningEffort); ReasoningEfforts[value] {
		effort = value
	}
	if _, err = tx.Exec(ctx, `INSERT INTO online_agent_games(match_id,agent_seat,model_name,reasoning_effort,engine_think_ms,verified,invite_id,runner) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		game.MatchID, game.AgentSeat, game.ModelName, effort, game.EngineThinkMs, inviteID != nil, inviteID, runner); err != nil {
		return false, err
	}
	return inviteID != nil, tx.Commit(ctx)
}

// Report is one browser-reported game result for the browser board.
type Report struct {
	ClientGameID    string
	ModelName       string
	ReasoningEffort string
	EngineThinkMs   int
	Result          string
	MoveCount       int
}

var clientGameIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

// RecordClient stores one browser-reported result. The report is validated
// here, so every caller keeps the table's checks: a report outside its
// bounds is ErrInvalidReport, and a repeated client game id is stored once
// and quietly ignored after.
func (s *Store) RecordClient(ctx context.Context, report Report) error {
	stored, err := report.validated()
	if err != nil {
		return err
	}
	var effort any
	if stored.ReasoningEffort != "" {
		effort = stored.ReasoningEffort
	}
	_, err = s.db.Exec(ctx, `INSERT INTO agent_client_games(client_game_id,model_name,reasoning_effort,engine_think_ms,result,move_count) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (client_game_id) DO NOTHING`,
		stored.ClientGameID, stored.ModelName, effort, stored.EngineThinkMs, stored.Result, stored.MoveCount)
	return err
}

// validated returns the report in the shape the table stores, or
// ErrInvalidReport when the report is outside its bounds.
func (r Report) validated() (Report, error) {
	stored := Report{
		ClientGameID:    strings.TrimSpace(r.ClientGameID),
		ModelName:       agentname.Clean(r.ModelName),
		ReasoningEffort: strings.ToLower(strings.TrimSpace(r.ReasoningEffort)),
		EngineThinkMs:   r.EngineThinkMs,
		Result:          r.Result,
		MoveCount:       r.MoveCount,
	}
	switch {
	case !clientGameIDPattern.MatchString(stored.ClientGameID):
		return Report{}, ErrInvalidReport
	case stored.ModelName == "":
		return Report{}, ErrInvalidReport
	case stored.ReasoningEffort != "" && !ReasoningEfforts[stored.ReasoningEffort]:
		return Report{}, ErrInvalidReport
	case stored.EngineThinkMs < 100 || stored.EngineThinkMs > 10_000:
		return Report{}, ErrInvalidReport
	case !results[stored.Result]:
		return Report{}, ErrInvalidReport
	case stored.MoveCount < 0 || stored.MoveCount > 1000:
		return Report{}, ErrInvalidReport
	}
	return stored, nil
}

// IssueInvite creates an invite and returns its code. The code is shown once:
// only its hash is stored.
func (s *Store) IssueInvite(ctx context.Context, label string, uses int) (string, string, error) {
	if uses <= 0 || strings.TrimSpace(label) == "" {
		return "", "", errors.New("agentboards: an invite needs a label and at least one use")
	}
	var raw [24]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", "", err
	}
	var id [8]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", "", err
	}
	code := codePrefix + hex.EncodeToString(raw[:])
	inviteID := "inv_" + hex.EncodeToString(id[:])
	_, err := s.db.Exec(ctx, `INSERT INTO online_agent_invites(invite_id,code_hash,label,uses_left) VALUES($1,$2,$3,$4)`, inviteID, hashCode(code), strings.TrimSpace(label), uses)
	return inviteID, code, err
}

// Level names Stockfish's strength band on the boards.
func Level(thinkMs int) string {
	switch {
	case thinkMs < 500:
		return "casual"
	case thinkMs < 3000:
		return "club"
	default:
		return "strong"
	}
}

// Row is one model at one level and one reasoning effort. An empty effort
// holds games whose effort was never reported.
type Row struct {
	Model           string  `json:"model"`
	ReasoningEffort string  `json:"reasoningEffort"`
	Level           string  `json:"level"`
	Games           int     `json:"games"`
	Wins            int     `json:"wins"`
	Draws           int     `json:"draws"`
	Losses          int     `json:"losses"`
	Score           float64 `json:"score"`
}

// Board is one board.
type Board struct {
	Board     string    `json:"board"`
	Rows      []Row     `json:"rows"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Read aggregates the finished games of one board. Aborted games are left
// out: an abort is unscored. An unknown board name is the community board.
func (s *Store) Read(ctx context.Context, board string) (Board, error) {
	name := board
	if name != BoardVerified && name != BoardBrowser {
		name = BoardCommunity
	}
	query, args := boardQuery(name)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return Board{}, err
	}
	defer rows.Close()
	result := Board{Board: name, Rows: []Row{}, UpdatedAt: time.Now().UTC()}
	for rows.Next() {
		var row Row
		if err = rows.Scan(&row.Model, &row.ReasoningEffort, &row.Level, &row.Games, &row.Wins, &row.Draws, &row.Losses); err != nil {
			return Board{}, err
		}
		row.Score = (float64(row.Wins) + 0.5*float64(row.Draws)) / float64(row.Games)
		result.Rows = append(result.Rows, row)
	}
	return result, rows.Err()
}

// boardQuery picks the aggregation of one board with its arguments: the MCP
// games for the community and verified boards, the browser-reported games
// for the browser board. The verified flag scopes the MCP query.
func boardQuery(name string) (query string, args []any) {
	if name == BoardBrowser {
		return `SELECT model_name,
				COALESCE(reasoning_effort, '') AS effort,
				CASE WHEN engine_think_ms < 500 THEN 'casual' WHEN engine_think_ms < 3000 THEN 'club' ELSE 'strong' END AS level,
				count(*),
				count(*) FILTER (WHERE result = 'win'),
				count(*) FILTER (WHERE result = 'draw'),
				count(*) FILTER (WHERE result = 'loss')
			FROM agent_client_games
			GROUP BY 1, 2, 3
			ORDER BY 3, (count(*) FILTER (WHERE result = 'win') + 0.5 * count(*) FILTER (WHERE result = 'draw'))::float / count(*) DESC, 4 DESC, 1, 2
			LIMIT 200`, nil
	}
	return `SELECT g.model_name,
			COALESCE(g.reasoning_effort, '') AS effort,
			CASE WHEN g.engine_think_ms < 500 THEN 'casual' WHEN g.engine_think_ms < 3000 THEN 'club' ELSE 'strong' END AS level,
			count(*),
			count(*) FILTER (WHERE m.result->>'winner' = g.agent_seat),
			count(*) FILTER (WHERE m.result->>'kind' = 'draw'),
			count(*) FILTER (WHERE m.result->>'winner' IS NOT NULL AND m.result->>'winner' <> g.agent_seat)
		FROM online_agent_games g JOIN online_matches m ON m.match_id = g.match_id
		WHERE g.verified = $1 AND m.status = 'completed' AND m.result->>'kind' <> 'abort'
		GROUP BY 1, 2, 3
		ORDER BY 3, (count(*) FILTER (WHERE m.result->>'winner' = g.agent_seat) + 0.5 * count(*) FILTER (WHERE m.result->>'kind' = 'draw'))::float / count(*) DESC, 4 DESC, 1, 2
			LIMIT 200`, []any{name == BoardVerified}
}

