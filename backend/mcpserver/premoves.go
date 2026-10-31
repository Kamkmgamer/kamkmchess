package mcpserver

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// maxPremoveDepth counts the pre-moved replies one plan may nest below the played move.
const maxPremoveDepth = 3

// maxPremoveBranches bounds the conditional branches per level.
const maxPremoveBranches = 8

// armedPremoveNode is one armed condition: when the opponent's next move equals
// Trigger, the agent's seat plays Reply without a new turn, and Premoves re-arm with
// the reply. The server never judges chess legality; the match authority drops a
// reply it finds illegal, exactly like the page discards a premove it can no longer
// play. A restart simply drops plans that were never fired.
type armedPremoveNode struct {
	Trigger  string             `json:"trigger"`
	Reply    string             `json:"reply"`
	Premoves []armedPremoveNode `json:"premoves,omitempty"`
}

// premoveRegistry keeps each agent seat's armed conditional pre-moves per match.
// Entries are consumed by the seat's own observation of the position, so the map
// holds at most one plan per pending reply and dies with the process.
type premoveRegistry struct {
	mu    sync.Mutex
	plans map[string][]armedPremoveNode
}

func newPremoveRegistry() *premoveRegistry {
	return &premoveRegistry{plans: make(map[string][]armedPremoveNode)}
}

func premoveKey(matchID string, seat online.Seat) string {
	return matchID + "\x00" + string(seat)
}

// arm replaces the seat's armed plan with a private copy, so a later mutation of the
// caller's slice cannot change what will fire.
func (r *premoveRegistry) arm(matchID string, seat online.Seat, nodes []armedPremoveNode) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.plans[premoveKey(matchID, seat)] = append([]armedPremoveNode(nil), nodes...)
}

// armed returns a copy of the seat's armed plan, or nil.
func (r *premoveRegistry) armed(matchID string, seat online.Seat) []armedPremoveNode {
	r.mu.Lock()
	defer r.mu.Unlock()
	nodes := r.plans[premoveKey(matchID, seat)]
	if len(nodes) == 0 {
		return nil
	}
	return append([]armedPremoveNode(nil), nodes...)
}

// clear consumes the seat's armed plan.
func (r *premoveRegistry) clear(matchID string, seat online.Seat) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.plans, premoveKey(matchID, seat))
}

// parsePremovePlan reads the optional premoves argument of make_move. It validates
// shape and budgets before the move executes, so a malformed plan is a readable tool
// error and never counts as an illegal move.
func parsePremovePlan(raw any) ([]armedPremoveNode, error) {
	if raw == nil {
		return nil, nil
	}
	list, ok := raw.([]any)
	if !ok || len(list) == 0 || len(list) > maxPremoveBranches {
		return nil, errors.New("premoves must be an array of at most 8 {on, then} entries")
	}
	return parsePremoveBranches(list, 1)
}

func parsePremoveBranches(list []any, depth int) ([]armedPremoveNode, error) {
	if depth > maxPremoveDepth {
		return nil, fmt.Errorf("premoves nest at most %d replies deep", maxPremoveDepth)
	}
	nodes := make([]armedPremoveNode, 0, len(list))
	for _, entry := range list {
		record, ok := entry.(map[string]any)
		if !ok {
			return nil, errors.New("each premoves entry must be an object with on and then")
		}
		onValue, ok := record["on"].([]any)
		if !ok || len(onValue) == 0 || len(onValue) > maxPremoveBranches {
			return nil, errors.New("premoves on must list at least one and at most 8 opponent coordinate replies")
		}
		var branch armedPremoveNode
		switch then := record["then"].(type) {
		case string:
			normalized := strings.ToLower(strings.TrimSpace(then))
			if !coordinateMove.MatchString(normalized) {
				return nil, fmt.Errorf("%q is not a coordinate move", then)
			}
			branch.Reply = normalized
		case map[string]any:
			move, _ := then["move"].(string)
			normalized := strings.ToLower(strings.TrimSpace(move))
			if !coordinateMove.MatchString(normalized) {
				return nil, errors.New("premoves then.move must be one coordinate move")
			}
			branch.Reply = normalized
			if rawNested, exists := then["premoves"]; exists && rawNested != nil {
				nestedList, ok := rawNested.([]any)
				if !ok || len(nestedList) == 0 || len(nestedList) > maxPremoveBranches {
					return nil, errors.New("premoves then.premoves must be an array of at most 8 entries")
				}
				nested, err := parsePremoveBranches(nestedList, depth+1)
				if err != nil {
					return nil, err
				}
				branch.Premoves = nested
			}
		default:
			return nil, errors.New("premoves then must be a coordinate move or an object with move and optional premoves")
		}
		for _, value := range onValue {
			text, ok := value.(string)
			if !ok {
				return nil, errors.New("premoves on entries must be coordinate strings")
			}
			normalized := strings.ToLower(strings.TrimSpace(text))
			if !coordinateMove.MatchString(normalized) {
				return nil, fmt.Errorf("%q is not a coordinate move", text)
			}
			nodes = append(nodes, armedPremoveNode{Trigger: normalized, Reply: branch.Reply, Premoves: branch.Premoves})
		}
	}
	return nodes, nil
}

// castlingKey collapses the two square forms a castle may be written in — by the
// king's landing square (e1g1) or by the rook square chessops and Stockfish emit
// (e1h1) — and likewise the queenside pairs. Standard chess cannot otherwise move a
// king two squares, so collapsing is exact there; a custom starting position with a
// king on its e-file is the accepted exception.
func castlingKey(uci string) string {
	switch uci {
	case "e1g1", "e1h1":
		return "e1g1"
	case "e8g8", "e8h8":
		return "e8g8"
	case "e1c1", "e1a1":
		return "e1c1"
	case "e8c8", "e8a8":
		return "e8c8"
	}
	return uci
}

// armedTriggerMatches reports whether an armed trigger denotes the played move. Both
// sides are normalized: plans normally arrive normalized, but a stored plan must never
// misfire over whitespace or letter case.
func armedTriggerMatches(trigger, playedUCI string) bool {
	return castlingKey(strings.ToLower(strings.TrimSpace(trigger))) ==
		castlingKey(strings.ToLower(strings.TrimSpace(playedUCI)))
}
