package mcpserver

import (
	"context"
	"strings"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

type renamingMatches struct {
	fakeMatches
	renamed []string
}

func (r *renamingMatches) RenameAgentSeat(_ context.Context, matchID string, seat online.Seat, ownerID, label string) error {
	r.renamed = append(r.renamed, matchID+"|"+string(seat)+"|"+ownerID+"|"+label)
	return nil
}

func TestPersistSeatNameStoresTheReportedNameOnTheSeat(t *testing.T) {
	matches := &renamingMatches{}
	server := &Server{options: Options{Matches: matches}}
	principal := onlineauth.Principal{Participant: online.ParticipantRef{ID: "mcp-agent:b"}}
	principal.MatchID, principal.Seat = "m1", online.SeatBlack
	match := online.Match{MatchID: "m1", Status: online.MatchActive, Seats: []online.MatchSeat{
		{Seat: online.SeatBlack, PublicLabel: "Invited agent", Control: online.SeatControl{Kind: online.ControlAgent}},
	}}
	server.persistSeatName(context.Background(), match, principal, "Claude Opus 5.5")
	if len(matches.renamed) != 1 || matches.renamed[0] != "m1|black|mcp-agent:b|Claude Opus 5.5 (self-reported)" {
		t.Fatalf("renamed = %v", matches.renamed)
	}
	match.Status = online.MatchCompleted
	server.persistSeatName(context.Background(), match, principal, "Other")
	if len(matches.renamed) != 1 {
		t.Fatalf("a finished match was renamed: %v", matches.renamed)
	}
}

func TestSeatLabelFitsThePublicLabelBound(t *testing.T) {
	label := seatLabel(strings.Repeat("é", 40))
	if len(label) > 64 || !strings.HasSuffix(label, " (self-reported)") {
		t.Fatalf("label %q (%d bytes)", label, len(label))
	}
}
