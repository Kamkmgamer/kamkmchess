package history

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/subject"
	"github.com/jackc/pgx/v5"
)

// Querier is the read surface the projection uses.
//
// A transaction and a pool both satisfy it, so the projection reads the
// shared match state inside the transaction that publishes it.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// projectedParticipant is one seat of a projected match.
type projectedParticipant struct {
	Seat        online.Seat
	OwnerKind   string
	OwnerID     string
	PublicLabel string
	Control     DeclaredControl
}

// timelineRow is one declared control of one seat.
type timelineRow struct {
	Version     int64
	ControlKind string
	ModelLabel  *string
}

// ProjectMatch publishes the public replay and the profile results of one
// completed match.
//
// The projection is idempotent. The replay is written once, and a result row
// is written once per account and game, so running the projection again never
// counts a result twice and never overwrites an anonymized payload.
//
// The projection is fenced against a concurrent removal. It takes the match
// lock first, so a removal of the same match is ordered against it, and it
// refuses to publish a match whose shared replay was erased. A late first
// projection therefore never resurrects a removed game.
//
// The answer is the canonical stored projection, not the payload this call
// built. A removal that committed in between rewrites or revokes the stored
// replay, and the caller must see that stored truth.
func (s *Service) ProjectMatch(ctx context.Context, matchID string) (Replay, error) {
	matchID = strings.TrimSpace(matchID)
	if matchID == "" {
		return Replay{}, ErrInvalidArgument
	}
	// The participants are read before the transaction, because the profile
	// resolution takes the account lock and the account lock always precedes
	// the match lock. The removal takes the locks in the same order, so the
	// two paths cannot deadlock.
	participants, err := s.readParticipants(ctx, s.db, matchID)
	if err != nil {
		return Replay{}, err
	}
	profileIDs, err := s.resolveProfiles(ctx, participants)
	if err != nil {
		return Replay{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Replay{}, err
	}
	defer tx.Rollback(ctx)
	// The match lock orders the projection against the removal of the same
	// match. The removal takes the same lock first, so the two are never
	// interleaved.
	if _, err = tx.Exec(ctx, `SELECT match_id FROM online_matches WHERE match_id=$1 FOR UPDATE`, matchID); err != nil {
		return Replay{}, err
	}
	removed, err := matchErased(ctx, tx, matchID)
	if err != nil {
		return Replay{}, err
	}
	if removed {
		// The shared replay of this match was erased. A late projection must
		// not bring it back.
		return Replay{}, ErrNotFound
	}
	replay, participants, err := s.buildReplay(ctx, tx, matchID)
	if err != nil {
		return Replay{}, err
	}
	raw, err := json.Marshal(replay)
	if err != nil {
		return Replay{}, err
	}
	resultRaw, err := json.Marshal(replay.Result)
	if err != nil {
		return Replay{}, err
	}
	hash := sha256.Sum256(resultRaw)

	if _, err = tx.Exec(ctx, `
		INSERT INTO online_public_replays(match_id,schema_version,replay_json,result_hash,game_kind,scored,published_at)
		VALUES($1,$2,$3::jsonb,$4,$5,$6,$7)
		ON CONFLICT (match_id) DO NOTHING`,
		replay.MatchID, ReplaySchemaVersion, string(raw), hash[:], string(replay.GameKind), replay.Scored, replay.CompletedAt.UTC()); err != nil {
		return Replay{}, err
	}
	for _, participant := range participants {
		profileID, ok := profileIDs[participant.OwnerID]
		if !ok || profileID == "" {
			// A guest has no profile, and a guest result is never counted
			// against an account.
			continue
		}
		opponent := opponentOf(participants, participant.Seat)
		outcome, scored := participantOutcome(replay.Result, participant.Seat)
		opponentProfile := ""
		if opponent.OwnerKind == string(online.ParticipantAccount) {
			opponentProfile = profileIDs[opponent.OwnerID]
		}
		tag, err := tx.Exec(ctx, `
			INSERT INTO online_profile_results(profile_id,match_id,seat,outcome,scored,game_kind,opponent_label,opponent_profile_id,completed_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
			ON CONFLICT (profile_id,match_id) DO NOTHING`,
			profileID, replay.MatchID, string(participant.Seat), string(outcome), scored, string(replay.GameKind), opponent.PublicLabel, nullable(opponentProfile), replay.CompletedAt.UTC())
		if err != nil {
			return Replay{}, err
		}
		if tag.RowsAffected() == 0 {
			// The result was already counted. The aggregate totals are only
			// moved for a result that this call inserted, so a repeated
			// projection never counts a game twice.
			continue
		}
		if err = addTotal(ctx, tx, profileID, outcome); err != nil {
			return Replay{}, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return Replay{}, err
	}
	// The canonical answer is the stored projection. A removal that committed
	// after this publication rewrote or revoked it, and the caller must read
	// that stored truth rather than the payload this call built.
	stored, found, err := s.readReplay(ctx, s.db, matchID)
	if err != nil {
		return Replay{}, err
	}
	if !found {
		return Replay{}, ErrNotFound
	}
	return stored, nil
}

// matchErased reports whether the shared replay of a match was erased.
//
// Only an explicit removal erases a shared replay. An ordinary account
// deletion anonymizes the shared game and keeps it, so its projection stays
// allowed: the seats it reads are the anonymized ones.
func matchErased(ctx context.Context, q Querier, matchID string) (bool, error) {
	var erased bool
	err := q.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM online_removal_ledger l
			JOIN online_removal_requests r ON r.removal_id = l.removal_id
			WHERE l.match_id = $1 AND l.scope = 'explicit_removal')`, matchID).Scan(&erased)
	if err != nil {
		return false, err
	}
	return erased, nil
}

// addTotal moves the aggregate totals of one profile by one result.
func addTotal(ctx context.Context, tx pgx.Tx, profileID string, outcome Outcome) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO online_profile_result_totals(profile_id,wins,draws,losses,aborts,updated_at)
		VALUES($1,
			CASE WHEN $2='win' THEN 1 ELSE 0 END,
			CASE WHEN $2='draw' THEN 1 ELSE 0 END,
			CASE WHEN $2='loss' THEN 1 ELSE 0 END,
			CASE WHEN $2='abort' THEN 1 ELSE 0 END,
			clock_timestamp())
		ON CONFLICT (profile_id) DO UPDATE SET
			wins = online_profile_result_totals.wins + CASE WHEN $2='win' THEN 1 ELSE 0 END,
			draws = online_profile_result_totals.draws + CASE WHEN $2='draw' THEN 1 ELSE 0 END,
			losses = online_profile_result_totals.losses + CASE WHEN $2='loss' THEN 1 ELSE 0 END,
			aborts = online_profile_result_totals.aborts + CASE WHEN $2='abort' THEN 1 ELSE 0 END,
			updated_at = clock_timestamp()`, profileID, string(outcome))
	return err
}

// participantOutcome is the result one participant earned.
//
// An abort is unscored: it is published as an abort and it is never a win, a
// draw or a loss.
func participantOutcome(result online.Result, seat online.Seat) (Outcome, bool) {
	switch result.Kind {
	case online.ResultWin:
		if result.Winner != nil && *result.Winner == seat {
			return OutcomeWin, true
		}
		return OutcomeLoss, true
	case online.ResultDraw:
		return OutcomeDraw, true
	default:
		return OutcomeAbort, false
	}
}

// opponentOf returns the other participant of a match.
func opponentOf(participants []projectedParticipant, seat online.Seat) projectedParticipant {
	for _, participant := range participants {
		if participant.Seat != seat {
			return participant
		}
	}
	return projectedParticipant{}
}

// resolveProfiles returns the public profile of every account participant.
//
// The resolution runs before the projection takes the match lock, because the
// profile service takes the account lock. The account lock always precedes
// the match lock, in the projection and in the removal, so the two paths
// cannot deadlock.
//
// An account that was deleted has no public history any more: its profile is
// not created and its result rows are never written again.
func (s *Service) resolveProfiles(ctx context.Context, participants []projectedParticipant) (map[string]string, error) {
	profileIDs := map[string]string{}
	for _, participant := range participants {
		if participant.OwnerKind != string(online.ParticipantAccount) || participant.OwnerID == "" {
			continue
		}
		if _, ok := profileIDs[participant.OwnerID]; ok {
			continue
		}
		var deleted bool
		if err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM online_account_deletions WHERE account_id = $1)`, subject.Reference(participant.OwnerID)).Scan(&deleted); err != nil {
			return nil, err
		}
		if deleted {
			continue
		}
		profileID, err := s.profileFor(ctx, participant.OwnerID)
		if err != nil {
			if errors.Is(err, ErrProfileClosed) || errors.Is(err, ErrNotFound) {
				continue
			}
			return nil, err
		}
		if profileID != "" {
			profileIDs[participant.OwnerID] = profileID
		}
	}
	return profileIDs, nil
}

// profileFor returns the public profile of an account, creating it when the
// account has none.
func (s *Service) profileFor(ctx context.Context, accountID string) (string, error) {
	if s.profiles == nil {
		return "", ErrNotFound
	}
	return s.profiles.EnsureProfileForAccount(ctx, accountID)
}

// buildReplay reads the shared match state and builds the public replay.
//
// The read runs in the caller's transaction, so the payload is the state the
// projection lock ordered against the removals.
func (s *Service) buildReplay(ctx context.Context, q Querier, matchID string) (Replay, []projectedParticipant, error) {
	var (
		matchIDOut   string
		variant      string
		startingFEN  string
		startingTime int64
		increment    int64
		status       string
		resultRaw    []byte
		rulesPolicy  string
		completedAt  *time.Time
	)
	err := q.QueryRow(ctx, `
		SELECT match_id,variant,starting_fen,starting_time_ms,increment_ms,status,result,rules_policy_version,completed_at
		FROM online_matches WHERE match_id=$1`, matchID).
		Scan(&matchIDOut, &variant, &startingFEN, &startingTime, &increment, &status, &resultRaw, &rulesPolicy, &completedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Replay{}, nil, ErrNotFound
		}
		return Replay{}, nil, err
	}
	if status == string(online.MatchActive) || completedAt == nil || len(resultRaw) == 0 {
		return Replay{}, nil, ErrNotCompleted
	}
	var result online.Result
	if err = json.Unmarshal(resultRaw, &result); err != nil {
		return Replay{}, nil, fmt.Errorf("%w: the stored result", ErrInvalidArgument)
	}
	if err = result.Validate(); err != nil {
		return Replay{}, nil, err
	}

	participants, err := s.readParticipants(ctx, q, matchID)
	if err != nil {
		return Replay{}, nil, err
	}
	if len(participants) != 2 {
		return Replay{}, nil, fmt.Errorf("%w: the match participants", ErrInvalidArgument)
	}
	moves, err := s.readMoves(ctx, q, matchID)
	if err != nil {
		return Replay{}, nil, err
	}
	timeline, err := s.readTimeline(ctx, q, matchID)
	if err != nil {
		return Replay{}, nil, err
	}
	terminal, err := s.readTerminal(ctx, q, matchID)
	if err != nil {
		return Replay{}, nil, err
	}
	gameKind, err := s.readGameKind(ctx, q, matchID)
	if err != nil {
		return Replay{}, nil, err
	}

	replayParticipants := make([]ReplayParticipant, 0, len(participants))
	for _, participant := range participants {
		replayParticipants = append(replayParticipants, ReplayParticipant{
			Seat:        participant.Seat,
			PublicLabel: participant.PublicLabel,
			Control:     participant.Control,
		})
	}
	replayMoves := make([]ReplayMove, 0, len(moves))
	for _, move := range moves {
		replayMoves = append(replayMoves, ReplayMove{
			Version: move.Version,
			Seat:    move.Seat,
			UCI:     move.UCI,
			SAN:     move.SAN,
			Control: controlAt(timeline, move.Seat, move.Version),
		})
	}
	replay := Replay{
		SchemaVersion:      ReplaySchemaVersion,
		MatchID:            matchIDOut,
		Variant:            variant,
		StartingFEN:        startingFEN,
		TimeControl:        online.TimeControl{StartingTimeMs: startingTime, IncrementMs: increment},
		GameKind:           gameKind,
		Scored:             result.Kind != online.ResultAbort,
		Attribution:        Attribution{Source: DeclarationDeclared, ProviderVerified: false},
		Participants:       replayParticipants,
		Moves:              replayMoves,
		Result:             result,
		RulesPolicyVersion: rulesPolicy,
		CompletedAt:        completedAt.UTC(),
	}
	if terminal != nil {
		replay.Terminal = &TerminalAction{
			Kind:    terminalKind(result, terminal.EventKind),
			Seat:    terminal.Seat,
			Control: controlAt(timeline, terminal.Seat, terminal.Version),
		}
	}
	if err = replay.Validate(); err != nil {
		return Replay{}, nil, err
	}
	return replay, participants, nil
}

// readParticipants reads the seats of a match.
func (s *Service) readParticipants(ctx context.Context, q Querier, matchID string) ([]projectedParticipant, error) {
	rows, err := q.Query(ctx, `
		SELECT seat,owner_kind,owner_id,public_label,control_kind,model_label
		FROM online_seats WHERE match_id=$1
		ORDER BY CASE seat WHEN 'white' THEN 0 ELSE 1 END`, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	participants := make([]projectedParticipant, 0, 2)
	for rows.Next() {
		var (
			participant projectedParticipant
			seat        string
			kind        string
			label       *string
		)
		if err = rows.Scan(&seat, &participant.OwnerKind, &participant.OwnerID, &participant.PublicLabel, &kind, &label); err != nil {
			return nil, err
		}
		participant.Seat = online.Seat(seat)
		participant.Control = declaredControl(kind, label)
		participants = append(participants, participant)
	}
	return participants, rows.Err()
}

// readMoves reads the accepted moves of a match.
func (s *Service) readMoves(ctx context.Context, q Querier, matchID string) ([]online.Move, error) {
	rows, err := q.Query(ctx, `SELECT version,seat,uci,san FROM online_moves WHERE match_id=$1 ORDER BY version`, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	moves := make([]online.Move, 0)
	for rows.Next() {
		var (
			move online.Move
			seat string
		)
		if err = rows.Scan(&move.Version, &seat, &move.UCI, &move.SAN); err != nil {
			return nil, err
		}
		move.Seat = online.Seat(seat)
		moves = append(moves, move)
	}
	return moves, rows.Err()
}

// readTimeline reads the declared control timeline of a match.
func (s *Service) readTimeline(ctx context.Context, q Querier, matchID string) (map[online.Seat][]timelineRow, error) {
	rows, err := q.Query(ctx, `SELECT seat,version,control_kind,model_label FROM online_seat_control_timeline WHERE match_id=$1 ORDER BY seat,version`, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	timeline := map[online.Seat][]timelineRow{}
	for rows.Next() {
		var (
			row   timelineRow
			seat  string
			kind  string
			label *string
		)
		if err = rows.Scan(&seat, &row.Version, &kind, &label); err != nil {
			return nil, err
		}
		row.ControlKind = kind
		row.ModelLabel = label
		key := online.Seat(seat)
		timeline[key] = append(timeline[key], row)
	}
	return timeline, rows.Err()
}

// terminalEvent is the event that ended the match.
type terminalEvent struct {
	Version   int64
	Seat      online.Seat
	EventKind string
}

// readTerminal reads the event that ended the match.
func (s *Service) readTerminal(ctx context.Context, q Querier, matchID string) (*terminalEvent, error) {
	var (
		terminal terminalEvent
		seat     string
	)
	err := q.QueryRow(ctx, `
		SELECT version,seat,event_kind FROM online_events
		WHERE match_id=$1 AND result IS NOT NULL
		ORDER BY version DESC LIMIT 1`, matchID).
		Scan(&terminal.Version, &seat, &terminal.EventKind)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	terminal.Seat = online.Seat(seat)
	return &terminal, nil
}

// readGameKind classifies the kind of the published game.
//
// A match with the browser Stockfish seat is a fallback game, whatever
// requested it: the fallback opponent is the engine, and the ticket names the
// fallback game by that opponent. A match that a queue entry was assigned to
// is a queue game. Every other online match is a friend match. A local,
// private or practice save is never in these tables at all, so it can never be
// published.
func (s *Service) readGameKind(ctx context.Context, q Querier, matchID string) (GameKind, error) {
	var (
		queued   bool
		fallback bool
	)
	err := q.QueryRow(ctx, `
		SELECT
			EXISTS(SELECT 1 FROM online_seats WHERE match_id=$1 AND control_kind='engine'),
			EXISTS(SELECT 1 FROM online_queue_entries WHERE assigned_match_id=$1)`, matchID).
		Scan(&fallback, &queued)
	if err != nil {
		return "", err
	}
	switch {
	case fallback:
		return GameFallback, nil
	case queued:
		return GameQueue, nil
	default:
		return GameFriend, nil
	}
}

// controlAt returns the declared control of a seat at a match version.
//
// The control of an accepted move is the control that was in effect for that
// seat when the move was accepted. A later control change never relabels an
// earlier move.
func controlAt(timeline map[online.Seat][]timelineRow, seat online.Seat, version int64) DeclaredControl {
	rows := timeline[seat]
	chosen := DeclaredControl{Kind: online.ControlHuman, Declaration: DeclarationDeclared}
	for _, row := range rows {
		if row.Version > version {
			break
		}
		chosen = declaredControl(row.ControlKind, row.ModelLabel)
	}
	return chosen
}

// declaredControl builds a declared control from the stored values.
//
// The stored label is already publishable: the service resolves a declared
// label before it is stored. The check is repeated here, so a payload can
// never carry a label that the service would refuse to publish, even if a
// stored row was written by an older version.
func declaredControl(kind string, label *string) DeclaredControl {
	control := DeclaredControl{Kind: online.ControlKind(kind), Declaration: DeclarationDeclared}
	switch control.Kind {
	case online.ControlHuman:
		return control
	case online.ControlEngine:
		engine := EngineLabel
		control.ModelLabel = &engine
		return control
	case online.ControlAgent:
		if label == nil || *label == "" {
			neutral := NeutralModelLabel
			control.ModelLabel = &neutral
			return control
		}
		resolved, err := NormalizePublicLabel(*label)
		if err != nil {
			// A label the service would not publish is never published. The
			// neutral label states that a model was in control without naming
			// a private routing identity.
			neutral := NeutralModelLabel
			control.ModelLabel = &neutral
			return control
		}
		control.ModelLabel = &resolved
		return control
	default:
		control.Kind = online.ControlHuman
		return control
	}
}

// terminalKind names the action that ended the game.
//
// The kind states what happened, not who won. The seat states who acted, and
// the control states who was in control of that seat.
func terminalKind(result online.Result, eventKind string) string {
	switch result.Reason {
	case online.ReasonCheckmate:
		return "checkmate"
	case online.ReasonResignation:
		return "resign"
	case online.ReasonTimeout:
		return "timeout"
	case online.ReasonAbandonment:
		return "abandonment"
	case online.ReasonIllegalMove:
		return "illegal_move"
	case online.ReasonAgreement, online.ReasonStalemate, online.ReasonRepetition, online.ReasonFiftyMove, online.ReasonInsufficientMaterial:
		return "draw"
	case online.ReasonAbort, online.ReasonOpeningReplyTimeout:
		return "abort"
	default:
		return eventKind
	}
}

// readReplay reads one stored replay.
func (s *Service) readReplay(ctx context.Context, q Querier, matchID string) (Replay, bool, error) {
	var (
		raw     []byte
		revoked *time.Time
		hash    []byte
	)
	err := q.QueryRow(ctx, `SELECT replay_json,revoked_at,result_hash FROM online_public_replays WHERE match_id=$1`, matchID).
		Scan(&raw, &revoked, &hash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Replay{}, false, nil
		}
		return Replay{}, false, err
	}
	if revoked != nil {
		return Replay{}, false, nil
	}
	var replay Replay
	if err = json.Unmarshal(raw, &replay); err != nil {
		return Replay{}, false, fmt.Errorf("%w: the stored replay", ErrInvalidArgument)
	}
	if err = replay.Validate(); err != nil {
		return Replay{}, false, err
	}
	resultRaw, err := json.Marshal(replay.Result)
	if err != nil {
		return Replay{}, false, err
	}
	expected := sha256.Sum256(resultRaw)
	if len(hash) != len(expected) || !equalBytes(hash, expected[:]) {
		return Replay{}, false, fmt.Errorf("%w: the stored replay does not match its result", ErrInvalidArgument)
	}
	return replay, true, nil
}

// equalBytes compares two byte slices.
func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

// nullable returns a nil argument for an unset value.
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}
