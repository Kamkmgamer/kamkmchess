package mcpserver

import (
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

func TestPlayersReadyGatesOnlyTheFirstMove(t *testing.T) {
	s := &Server{sessions: newSessionStore(10, time.Hour, time.Now)}
	match := online.Match{
		MatchID: "m1",
		Status:  online.MatchActive,
		Seats: []online.MatchSeat{
			{Seat: online.SeatWhite, Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: AgentPrefix + "a"}, Control: online.SeatControl{Kind: online.ControlAgent}},
			{Seat: online.SeatBlack, Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: AgentPrefix + "b"}, Control: online.SeatControl{Kind: online.ControlAgent}},
		},
	}
	if s.PlayersReady(match) {
		t.Fatal("a game with no joined seats was ready")
	}
	match.Moves = []online.Move{{Seat: online.SeatWhite, UCI: "e2e4", SAN: "e4"}}
	if !s.PlayersReady(match) {
		t.Fatal("an in-progress game was still gated on live sessions")
	}
}
