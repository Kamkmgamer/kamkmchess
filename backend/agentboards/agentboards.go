// Package agentboards keeps the record of remote agent games and serves the
// community and verified boards.
//
// A game is verified only when it was started with an invite code an
// operator issued for the official runner. Everything else is a community
// result under a self-reported name.
package agentboards

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store reads and writes the agent game records.
type Store struct {
	db *pgxpool.Pool
}

// New returns a store on the pool.
func New(db *pgxpool.Pool) *Store { return &Store{db: db} }

// Game is one recorded agent game.
type Game struct {
	MatchID       string
	AgentSeat     string
	ModelName     string
	EngineThinkMs int
	Runner        string
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
	if _, err = tx.Exec(ctx, `INSERT INTO online_agent_games(match_id,agent_seat,model_name,engine_think_ms,verified,invite_id,runner) VALUES($1,$2,$3,$4,$5,$6,$7)`,
		game.MatchID, game.AgentSeat, game.ModelName, game.EngineThinkMs, inviteID != nil, inviteID, runner); err != nil {
		return false, err
	}
	return inviteID != nil, tx.Commit(ctx)
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

// Row is one model at one level.
type Row struct {
	Model  string  `json:"model"`
	Level  string  `json:"level"`
	Games  int     `json:"games"`
	Wins   int     `json:"wins"`
	Draws  int     `json:"draws"`
	Losses int     `json:"losses"`
	Score  float64 `json:"score"`
}

// Board is one board.
type Board struct {
	Board     string    `json:"board"`
	Rows      []Row     `json:"rows"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Read aggregates the finished games of one board. Aborted games are left
// out: an abort is unscored.
func (s *Store) Read(ctx context.Context, verified bool) (Board, error) {
	rows, err := s.db.Query(ctx, `SELECT g.model_name,
			CASE WHEN g.engine_think_ms < 500 THEN 'casual' WHEN g.engine_think_ms < 3000 THEN 'club' ELSE 'strong' END AS level,
			count(*),
			count(*) FILTER (WHERE m.result->>'winner' = g.agent_seat),
			count(*) FILTER (WHERE m.result->>'kind' = 'draw'),
			count(*) FILTER (WHERE m.result->>'winner' IS NOT NULL AND m.result->>'winner' <> g.agent_seat)
		FROM online_agent_games g JOIN online_matches m ON m.match_id = g.match_id
		WHERE g.verified = $1 AND m.status = 'completed' AND m.result->>'kind' <> 'abort'
		GROUP BY 1, 2
		ORDER BY 2, (count(*) FILTER (WHERE m.result->>'winner' = g.agent_seat) + 0.5 * count(*) FILTER (WHERE m.result->>'kind' = 'draw'))::float / count(*) DESC, 3 DESC, 1
		LIMIT 200`, verified)
	if err != nil {
		return Board{}, err
	}
	defer rows.Close()
	board := Board{Board: "community", Rows: []Row{}, UpdatedAt: time.Now().UTC()}
	if verified {
		board.Board = "verified"
	}
	for rows.Next() {
		var row Row
		if err = rows.Scan(&row.Model, &row.Level, &row.Games, &row.Wins, &row.Draws, &row.Losses); err != nil {
			return Board{}, err
		}
		row.Score = (float64(row.Wins) + 0.5*float64(row.Draws)) / float64(row.Games)
		board.Rows = append(board.Rows, row)
	}
	return board, rows.Err()
}
