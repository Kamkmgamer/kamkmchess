// Package history publishes the public game history and the public replays of
// completed online matches.
//
// The package is an allowlist. A public payload carries the starting position,
// the accepted moves, the time control, the result, the public participants and
// the declared control of every accepted move and of the terminal action. It
// never carries an account identifier, an authentication identifier, a session,
// a credential, a guest identifier, a private routing identity, a connection
// nickname, an endpoint, a provider request, a model conversation, or an owner
// archive.
//
// Two rules shape everything here.
//
// A declared model label is a declaration, never a provider attestation. The
// service publishes a label only when it knows it as a public model name or
// when the owner registered it as their own public label. Every other value is
// replaced by a neutral label before it is stored, so a private routing
// identity never reaches a shared table.
//
// A control change never relabels earlier play. The control of an accepted
// move is the control that was in effect for that seat at that match version,
// and the terminal action carries the control of the seat that ended the game.
package history

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

const (
	// ReplaySchemaVersion is the version of the public replay wire contract.
	ReplaySchemaVersion = 2
	// HistorySchemaVersion is the version of the public profile history wire
	// contract.
	HistorySchemaVersion = 1
	// DeclarationDeclared marks every attribution in a public payload as
	// declared. The service never attests that a provider produced a move.
	DeclarationDeclared = "declared"
	// NeutralModelLabel is the label a control falls back to when its declared
	// label is not publishable. It names a model without naming a private
	// routing identity.
	NeutralModelLabel = "Custom model"
	// EngineLabel is the label of the browser Stockfish seat. The fallback
	// engine belongs to the product, and its attribution is declared too.
	EngineLabel = "Stockfish 19 Lite (browser)"
	// ServerEngineLabel is the label of the native Stockfish seat the
	// server plays itself.
	ServerEngineLabel = "Stockfish (server)"
	// DeletedPlayerLabel is the public label of an anonymized participant.
	DeletedPlayerLabel = "Deleted player"
)

// GameKind names the kind of online game a published result belongs to.
type GameKind string

const (
	// GameFriend is an arranged friend match.
	GameFriend GameKind = "friend"
	// GameQueue is a match that came from the agent matchmaking queue.
	GameQueue GameKind = "queue"
	// GameFallback is a match whose opponent is the browser Stockfish engine.
	GameFallback GameKind = "fallback"
)

// Outcome is the result one participant earned in one game.
type Outcome string

const (
	// OutcomeWin is a scored win.
	OutcomeWin Outcome = "win"
	// OutcomeDraw is a scored draw.
	OutcomeDraw Outcome = "draw"
	// OutcomeLoss is a scored loss.
	OutcomeLoss Outcome = "loss"
	// OutcomeAbort is an unscored abort.
	OutcomeAbort Outcome = "abort"
)

// Errors reported by the history service.
var (
	// ErrNotFound reports a match, a replay or a profile that does not exist,
	// or a replay that was removed.
	ErrNotFound = errors.New("history: not found")
	// ErrInvalidArgument reports a refused argument.
	ErrInvalidArgument = errors.New("history: invalid argument")
	// ErrInvalidLabel reports a refused public label.
	ErrInvalidLabel = errors.New("history: the public label is not allowed")
	// ErrNotCompleted reports a match that has not reached a terminal result.
	ErrNotCompleted = errors.New("history: the match is not completed")
	// ErrProfileClosed reports the profile of a deleted account.
	//
	// A deleted account keeps no public identity, so the publisher never
	// creates a profile for it and never counts a result for it again.
	ErrProfileClosed = errors.New("history: the profile of a deleted account is closed")
)

// DeclaredControl is the declared control of one seat.
//
// The control kind is what the owner declared. The model label is a publishable
// label only, and the declaration states that neither value is verified by a
// provider.
type DeclaredControl struct {
	Kind        online.ControlKind `json:"kind"`
	ModelLabel  *string            `json:"modelLabel,omitempty"`
	Declaration string             `json:"declaration"`
}

// Validate checks the shape of a declared control.
func (c DeclaredControl) Validate() error {
	switch c.Kind {
	case online.ControlHuman:
		if c.ModelLabel != nil {
			return fmt.Errorf("%w: a human control has no model", ErrInvalidArgument)
		}
	case online.ControlAgent, online.ControlEngine:
		if c.ModelLabel == nil || !publishableLabel(*c.ModelLabel) {
			return fmt.Errorf("%w: the model label is not publishable", ErrInvalidArgument)
		}
	default:
		return fmt.Errorf("%w: the control kind is not known", ErrInvalidArgument)
	}
	if c.Declaration != DeclarationDeclared {
		return fmt.Errorf("%w: an attribution is always declared", ErrInvalidArgument)
	}
	return nil
}

// Attribution states how the control of a game is known.
type Attribution struct {
	// Source is always "declared".
	Source string `json:"source"`
	// ProviderVerified is always false. The service never confirms that a
	// provider produced a move or that a browser engine produced a result.
	ProviderVerified bool `json:"providerVerified"`
}

// ReplayParticipant is one public participant of a replay.
type ReplayParticipant struct {
	Seat        online.Seat     `json:"seat"`
	PublicLabel string          `json:"publicLabel"`
	Control     DeclaredControl `json:"control"`
}

// ReplayMove is one accepted move with the control that produced it.
type ReplayMove struct {
	Version int64           `json:"version"`
	Seat    online.Seat     `json:"seat"`
	UCI     string          `json:"uci"`
	SAN     string          `json:"san"`
	Control DeclaredControl `json:"control"`
}

// TerminalAction is the action that ended the game.
//
// The action carries the seat that performed it and the control that seat was
// under, so a terminal agent action is labeled as declared agent control.
type TerminalAction struct {
	Kind    string          `json:"kind"`
	Seat    online.Seat     `json:"seat"`
	Control DeclaredControl `json:"control"`
}

// Replay is the public replay of one completed online match.
type Replay struct {
	SchemaVersion      int                 `json:"schemaVersion"`
	MatchID            string              `json:"matchId"`
	Variant            string              `json:"variant"`
	StartingFEN        string              `json:"startingFen"`
	TimeControl        online.TimeControl  `json:"timeControl"`
	GameKind           GameKind            `json:"gameKind"`
	Scored             bool                `json:"scored"`
	Attribution        Attribution         `json:"attribution"`
	Participants       []ReplayParticipant `json:"participants"`
	Moves              []ReplayMove        `json:"moves"`
	Terminal           *TerminalAction     `json:"terminal"`
	Result             online.Result       `json:"result"`
	RulesPolicyVersion string              `json:"rulesPolicyVersion"`
	CompletedAt        time.Time           `json:"completedAt"`
}

// Validate checks the shape of a public replay.
func (r Replay) Validate() error {
	if r.SchemaVersion != ReplaySchemaVersion {
		return fmt.Errorf("%w: the replay schema version", ErrInvalidArgument)
	}
	if r.MatchID == "" || r.Variant == "" || r.StartingFEN == "" || r.RulesPolicyVersion == "" {
		return fmt.Errorf("%w: the replay identity", ErrInvalidArgument)
	}
	if r.CompletedAt.IsZero() {
		return fmt.Errorf("%w: the replay completion time", ErrInvalidArgument)
	}
	switch r.GameKind {
	case GameFriend, GameQueue, GameFallback:
	default:
		return fmt.Errorf("%w: the game kind", ErrInvalidArgument)
	}
	if err := r.Result.Validate(); err != nil {
		return err
	}
	if r.Scored != (r.Result.Kind != online.ResultAbort) {
		return fmt.Errorf("%w: an abort is unscored", ErrInvalidArgument)
	}
	if err := r.Attribution.Validate(); err != nil {
		return err
	}
	if len(r.Participants) != 2 {
		return fmt.Errorf("%w: the replay participants", ErrInvalidArgument)
	}
	seen := map[online.Seat]bool{}
	for _, participant := range r.Participants {
		if participant.Seat != online.SeatWhite && participant.Seat != online.SeatBlack {
			return fmt.Errorf("%w: the replay participant seat", ErrInvalidArgument)
		}
		if seen[participant.Seat] {
			return fmt.Errorf("%w: the replay participant seat is duplicated", ErrInvalidArgument)
		}
		seen[participant.Seat] = true
		if !publishableLabel(participant.PublicLabel) {
			return fmt.Errorf("%w: the participant public label", ErrInvalidArgument)
		}
		if err := participant.Control.Validate(); err != nil {
			return err
		}
	}
	for _, move := range r.Moves {
		if move.Version < 1 || move.UCI == "" || move.SAN == "" {
			return fmt.Errorf("%w: the replay move", ErrInvalidArgument)
		}
		if move.Seat != online.SeatWhite && move.Seat != online.SeatBlack {
			return fmt.Errorf("%w: the replay move seat", ErrInvalidArgument)
		}
		if err := move.Control.Validate(); err != nil {
			return err
		}
	}
	if r.Terminal != nil {
		if r.Terminal.Seat != online.SeatWhite && r.Terminal.Seat != online.SeatBlack {
			return fmt.Errorf("%w: the terminal action seat", ErrInvalidArgument)
		}
		if r.Terminal.Kind == "" {
			return fmt.Errorf("%w: the terminal action kind", ErrInvalidArgument)
		}
		if err := r.Terminal.Control.Validate(); err != nil {
			return err
		}
	}
	return nil
}

// Validate checks the shape of the attribution.
func (a Attribution) Validate() error {
	if a.Source != DeclarationDeclared {
		return fmt.Errorf("%w: the attribution source", ErrInvalidArgument)
	}
	if a.ProviderVerified {
		return fmt.Errorf("%w: an attribution is never provider verified", ErrInvalidArgument)
	}
	return nil
}

// Totals are the aggregate result counts of one profile.
//
// The totals survive an explicit removal, so the opponent of a removed player
// keeps the anonymous result aggregate of the erased games.
type Totals struct {
	Wins   int64 `json:"wins"`
	Draws  int64 `json:"draws"`
	Losses int64 `json:"losses"`
	Aborts int64 `json:"aborts"`
	Scored int64 `json:"scored"`
}

// HistoryEntry is one published game of a profile.
type HistoryEntry struct {
	MatchID       string    `json:"matchId"`
	ReplayPath    string    `json:"replayPath"`
	GameKind      GameKind  `json:"gameKind"`
	Outcome       Outcome   `json:"outcome"`
	Scored        bool      `json:"scored"`
	OpponentLabel string    `json:"opponentLabel"`
	CompletedAt   time.Time `json:"completedAt"`
}

// History is the public game history of one profile.
type History struct {
	SchemaVersion int            `json:"schemaVersion"`
	ProfileID     string         `json:"profileId"`
	Totals        Totals         `json:"totals"`
	Games         []HistoryEntry `json:"games"`
}

// ReplayPath is the public path of one replay.
func ReplayPath(matchID string) string {
	return "/v1/public/matches/" + matchID + "/replay"
}

// publishableLabel reports whether a label may appear in a public payload.
//
// A public label is a chosen name. It is never an email address, never a URL,
// never an endpoint, and never a control character.
func publishableLabel(label string) bool {
	if label == "" || len(label) > 64 || strings.TrimSpace(label) != label {
		return false
	}
	for _, r := range label {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return !strings.Contains(label, "@") && !strings.Contains(label, "://")
}
