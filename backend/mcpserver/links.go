package mcpserver

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

func otherSeat(seat online.Seat) online.Seat { other, _ := seat.Other(); return other }

func (s *Server) pageOrigin() string {
	if s.options.PageOrigin != "" {
		return strings.TrimRight(s.options.PageOrigin, "/")
	}
	if len(s.options.AllowedOrigins) > 0 {
		return strings.TrimRight(s.options.AllowedOrigins[0], "/")
	}
	return "https://chess.khalil.mageed.net"
}

func (s *Server) watchURL(matchID string) string {
	return s.pageOrigin() + "/play/agent?watch=" + url.QueryEscape(matchID)
}

func (s *Server) seatURL(matchID string, seat online.Seat, token string) string {
	return s.watchURL(matchID) + "&side=" + string(seat) + "#seat=" + url.QueryEscape(token)
}

func (s *Server) playersReady(match online.Match) bool {
	return s.PlayersReady(match)
}

// PlayersReady also gates the server engine until an invited agent connects.
func (s *Server) PlayersReady(match online.Match) bool {
	hasEngine := false
	for _, seat := range match.Seats {
		if seat.Control.Kind == online.ControlEngine {
			hasEngine = true
		}
	}
	if hasEngine {
		for _, seat := range match.Seats {
			if strings.HasPrefix(seat.Participant.ID, AgentPrefix) && !s.sessions.seatReady(match.MatchID, seat.Seat) {
				return false
			}
		}
		return true
	}
	return s.sessions.seatReady(match.MatchID, online.SeatWhite) && s.sessions.seatReady(match.MatchID, online.SeatBlack)
}

// watch exposes only anonymous MCP games, never private online matches or
// credentials. The random match ID is the shareable, read-only capability.
func (s *Server) watch(w http.ResponseWriter, r *http.Request) {
	match, err := s.options.Matches.GetMatch(r.Context(), r.URL.Query().Get("watch"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	for _, seat := range match.Seats {
		if !strings.HasPrefix(seat.Participant.ID, AgentPrefix) && seat.Control.Kind != online.ControlEngine {
			http.NotFound(w, r)
			return
		}
	}
	if match.Status != online.MatchActive {
		if history, ok := s.options.Matches.(interface {
			GetPublicProjection(context.Context, string) (online.PublicProjection, error)
		}); ok {
			if _, err := history.GetPublicProjection(r.Context(), match.MatchID); err != nil {
				http.NotFound(w, r)
				return
			}
		}
	}
	players := map[string]string{}
	moves := make([]string, 0, len(match.Moves))
	for _, seat := range match.Seats {
		players[string(seat.Seat)] = seat.PublicLabel
		if name := s.sessions.seatName(match.MatchID, seat.Seat); name != "" {
			players[string(seat.Seat)] = name + " (self-reported)"
		}
	}
	for _, move := range match.Moves {
		moves = append(moves, move.SAN)
	}
	status := string(match.Status)
	if match.Status == online.MatchActive && !s.playersReady(match) {
		status = "waiting-for-players"
	}
	writeJSON(w, http.StatusOK, map[string]any{"gameId": match.MatchID, "fen": match.PositionFEN, "status": status, "players": players, "moves": moves, "clock": s.clock(match), "result": match.Result, "watch_url": s.watchURL(match.MatchID)})
}
