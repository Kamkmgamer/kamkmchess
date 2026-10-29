package integration

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestMCPSharedInvitationsAndSpectators(t *testing.T) {
	_, creator := newMCPEndpoint(t)
	board, errText := creator.tool("start_game", map[string]any{"model_name": "White agent", "opponent": "agent", "defer_join": true})
	if errText != "" {
		t.Fatal(errText)
	}
	if board["status"] != "waiting-for-players" || !strings.Contains(board["opponent_url"].(string), "side=black#seat=") {
		t.Fatalf("invitations: %v", board)
	}
	if _, errText := creator.tool("make_move", map[string]any{"move": "e2e4"}); !strings.Contains(errText, "waiting") {
		t.Fatalf("premature move: %s", errText)
	}
	black := &mcpClient{t: t, url: creator.url}
	black.rpc("initialize", map[string]any{})
	joined, errText := black.tool("join_seat", map[string]any{"model_name": "Black agent", "resume_token": board["opponent_resume_token"]})
	if errText != "" || joined["yourSide"] != "black" || joined["status"] != "waiting-for-players" {
		t.Fatalf("black joined: %v %s", joined, errText)
	}
	white := &mcpClient{t: t, url: creator.url}
	white.rpc("initialize", map[string]any{})
	joined, errText = white.tool("join_seat", map[string]any{"model_name": "White agent", "resume_token": board["resume_token"]})
	if errText != "" || joined["yourSide"] != "white" || joined["status"] != "your-turn" {
		t.Fatalf("white joined: %v %s", joined, errText)
	}
	if _, errText := black.tool("make_move", map[string]any{"move": "e7e5"}); !strings.Contains(errText, "not your turn") {
		t.Fatalf("black controlled white: %s", errText)
	}
	// Send moves concurrently so make_move's bounded wait sees the reply.
	done := make(chan string, 1)
	go func() { _, e := white.tool("make_move", map[string]any{"move": "e2e4"}); done <- e }()
	if _, e := black.tool("wait_for_turn", nil); e != "" {
		t.Fatal(e)
	}
	// Resigning is immediate and releases the waiting White call.
	if _, e := black.tool("resign", nil); e != "" {
		t.Fatal(e)
	}
	if e := <-done; e != "" {
		t.Fatal(e)
	}
	response, err := http.Get(creator.url + "?watch=" + board["gameId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var watch map[string]any
	if err := json.NewDecoder(response.Body).Decode(&watch); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(watch)
	if response.StatusCode != 200 || watch["fen"] == nil || strings.Contains(string(encoded), board["resume_token"].(string)) || strings.Contains(string(encoded), "participant") {
		t.Fatalf("unsafe spectator response: %d %s", response.StatusCode, encoded)
	}
}

func TestMCPBlackInvitationDefersStockfishOpening(t *testing.T) {
	_, c := newMCPEndpoint(t)
	board, errText := c.tool("start_game", map[string]any{"model_name": "Invited Black", "color": "black", "defer_join": true, "engine_think_ms": 100})
	if errText != "" || board["moveCount"] != float64(0) {
		t.Fatalf("deferred game: %v %s", board, errText)
	}
	token := board["resume_token"]
	time.Sleep(250 * time.Millisecond)
	board, errText = c.tool("get_board", nil)
	if errText != "" || board["moveCount"] != float64(0) {
		t.Fatalf("engine moved before invitation accepted: %v %s", board, errText)
	}
	if _, e := c.tool("join_seat", map[string]any{"model_name": "Black", "resume_token": token}); e != "" {
		t.Fatal(e)
	}
	board, errText = c.tool("wait_for_turn", nil)
	if errText != "" || board["moveCount"] != float64(1) || board["status"] != "your-turn" {
		t.Fatalf("engine did not start after joining: %v %s", board, errText)
	}
	if _, e := c.tool("resign", nil); e != "" {
		t.Fatal(e)
	}
}
