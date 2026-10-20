package history

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ProfileResolver returns the public profile of an account.
//
// The resolver is the profile service. The history service never writes the
// profile table itself: it asks for the profile of an account and uses the
// stable public identifier it gets back.
type ProfileResolver interface {
	EnsureProfileForAccount(ctx context.Context, accountID string) (string, error)
}

// Options configures the history service.
type Options struct {
	// Now overrides the clock for tests.
	Now func() time.Time
}

// Service publishes the public history and the public replays.
//
// The service reads the shared match tables and writes only its own tables:
// the public replays, the profile results, the aggregate totals, and the
// owner's public labels. It never writes match state, never rewrites a
// received result, and never publishes a label it did not resolve.
type Service struct {
	db       *pgxpool.Pool
	profiles ProfileResolver
	options  Options
}

// Open binds the history service to a pool. It does not mutate the schema.
func Open(_ context.Context, db *pgxpool.Pool, profiles ProfileResolver, options Options) (*Service, error) {
	if db == nil {
		return nil, errors.New("history: nil database pool")
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Service{db: db, profiles: profiles, options: options}, nil
}

func (s *Service) now() time.Time { return s.options.Now().UTC() }

// PublicLabel is a public label an owner registered for their own account.
type PublicLabel struct {
	LabelID     string
	AccountID   string
	PublicLabel string
	CreatedAt   time.Time
}

// RegisterPublicLabel registers the public label an owner chose for their own
// model opponents.
//
// The label is registered on its own. The service never receives a routing
// identifier, an endpoint, a connection nickname, or a credential: the mapping
// from a private route to a public label stays in the owner's browser.
//
// A label that could carry a secret is refused. The screen is deliberately
// conservative, because a label that looks like a key must never reach a
// public payload.
func (s *Service) RegisterPublicLabel(ctx context.Context, accountID, label string) (PublicLabel, error) {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return PublicLabel{}, ErrInvalidArgument
	}
	normalized, err := NormalizePublicLabel(label)
	if err != nil {
		return PublicLabel{}, err
	}
	labelID, err := newIdentifier("kl_")
	if err != nil {
		return PublicLabel{}, err
	}
	created := s.now()
	var stored PublicLabel
	err = s.db.QueryRow(ctx, `
		INSERT INTO online_account_public_labels(label_id,account_id,public_label,created_at)
		VALUES($1,$2,$3,$4)
		ON CONFLICT (account_id, public_label)
		DO UPDATE SET revoked_at=NULL
		RETURNING label_id,account_id,public_label,created_at`, labelID, accountID, normalized, created).
		Scan(&stored.LabelID, &stored.AccountID, &stored.PublicLabel, &stored.CreatedAt)
	if err != nil {
		return PublicLabel{}, err
	}
	stored.CreatedAt = stored.CreatedAt.UTC()
	return stored, nil
}

// PublicLabels lists the public labels an account registered.
func (s *Service) PublicLabels(ctx context.Context, accountID string) ([]PublicLabel, error) {
	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return nil, ErrInvalidArgument
	}
	rows, err := s.db.Query(ctx, `SELECT label_id,account_id,public_label,created_at FROM online_account_public_labels WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at,label_id`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	labels := make([]PublicLabel, 0)
	for rows.Next() {
		var label PublicLabel
		if err = rows.Scan(&label.LabelID, &label.AccountID, &label.PublicLabel, &label.CreatedAt); err != nil {
			return nil, err
		}
		label.CreatedAt = label.CreatedAt.UTC()
		labels = append(labels, label)
	}
	return labels, rows.Err()
}

// PublicReplay reads the public replay of one match.
//
// The read is public: it needs no credential, and it answers with the
// allowlisted payload only. A match that is not completed yet has no public
// replay, and a removed replay is not found.
func (s *Service) PublicReplay(ctx context.Context, matchID string) (Replay, error) {
	matchID = strings.TrimSpace(matchID)
	if matchID == "" {
		return Replay{}, ErrInvalidArgument
	}
	replay, found, err := s.readReplay(ctx, s.db, matchID)
	if err != nil {
		return Replay{}, err
	}
	if found {
		return replay, nil
	}
	// The replay is published when the match completes. A read that arrives
	// before the publisher did publishes it on demand, so the public URL of a
	// finished match is never briefly missing.
	if _, err = s.ProjectMatch(ctx, matchID); err != nil {
		if errors.Is(err, ErrNotCompleted) {
			return Replay{}, ErrNotFound
		}
		return Replay{}, err
	}
	replay, found, err = s.readReplay(ctx, s.db, matchID)
	if err != nil {
		return Replay{}, err
	}
	if !found {
		return Replay{}, ErrNotFound
	}
	return replay, nil
}

// ProfileHistory reads the public game history of one profile.
//
// The read is public. It answers with the published games and the aggregate
// result totals. A removed game leaves both histories, and the opponent keeps
// the aggregate total of that result.
func (s *Service) ProfileHistory(ctx context.Context, profileID string) (History, error) {
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		return History{}, ErrInvalidArgument
	}
	history := History{SchemaVersion: HistorySchemaVersion, ProfileID: profileID, Games: []HistoryEntry{}}
	var totals online_profile_totals
	err := s.db.QueryRow(ctx, `SELECT wins,draws,losses,aborts FROM online_profile_result_totals WHERE profile_id=$1`, profileID).
		Scan(&totals.Wins, &totals.Draws, &totals.Losses, &totals.Aborts)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return History{}, err
	}
	history.Totals = Totals{Wins: totals.Wins, Draws: totals.Draws, Losses: totals.Losses, Aborts: totals.Aborts}
	history.Totals.Scored = totals.Wins + totals.Draws + totals.Losses
	rows, err := s.db.Query(ctx, `SELECT match_id,game_kind,outcome,scored,opponent_label,completed_at FROM online_profile_results WHERE profile_id=$1 ORDER BY completed_at DESC, match_id DESC`, profileID)
	if err != nil {
		return History{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			entry     HistoryEntry
			kind      string
			outcome   string
			completed time.Time
		)
		if err = rows.Scan(&entry.MatchID, &kind, &outcome, &entry.Scored, &entry.OpponentLabel, &completed); err != nil {
			return History{}, err
		}
		entry.GameKind = GameKind(kind)
		entry.Outcome = Outcome(outcome)
		entry.ReplayPath = ReplayPath(entry.MatchID)
		entry.CompletedAt = completed.UTC()
		history.Games = append(history.Games, entry)
	}
	if err = rows.Err(); err != nil {
		return History{}, err
	}
	return history, nil
}

// ProjectPending publishes the replays of the matches that completed and are
// not published yet. It is the sweeper of the publisher.
func (s *Service) ProjectPending(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.Query(ctx, `
		SELECT m.match_id
		FROM online_matches m
		LEFT JOIN online_public_replays r ON r.match_id = m.match_id
		WHERE m.status IN ('completed','aborted') AND r.match_id IS NULL
		ORDER BY m.completed_at, m.match_id
		LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pending := make([]string, 0)
	for rows.Next() {
		var matchID string
		if err = rows.Scan(&matchID); err != nil {
			return nil, err
		}
		pending = append(pending, matchID)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	published := make([]string, 0, len(pending))
	for _, matchID := range pending {
		if _, err = s.ProjectMatch(ctx, matchID); err != nil {
			if errors.Is(err, ErrNotCompleted) {
				continue
			}
			return published, err
		}
		published = append(published, matchID)
	}
	return published, nil
}

// online_profile_totals is the stored aggregate row.
type online_profile_totals struct {
	Wins   int64
	Draws  int64
	Losses int64
	Aborts int64
}
