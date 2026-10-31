package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/agentboards"
	"github.com/Kamkmgamer/kamkmchess/backend/mcpserver"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
)

// mcpClient speaks the MCP Streamable HTTP transport to the endpoint.
type mcpClient struct {
	t       *testing.T
	url     string
	session string
	nextID  int
}

func (c *mcpClient) rpc(method string, params any) (int, map[string]any) {
	c.t.Helper()
	c.nextID++
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": c.nextID, "method": method, "params": params})
	req, _ := http.NewRequest(http.MethodPost, c.url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if c.session != "" {
		req.Header.Set("Mcp-Session-Id", c.session)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	if id := res.Header.Get("Mcp-Session-Id"); id != "" {
		c.session = id
	}
	var out map[string]any
	if err = json.NewDecoder(res.Body).Decode(&out); err != nil {
		c.t.Fatalf("%s: undecodable answer: %v", method, err)
	}
	return res.StatusCode, out
}

// tool calls a tool and returns its structured result, or the error text.
func (c *mcpClient) tool(name string, args map[string]any) (map[string]any, string) {
	c.t.Helper()
	status, out := c.rpc("tools/call", map[string]any{"name": name, "arguments": args})
	if status != http.StatusOK || out["error"] != nil {
		c.t.Fatalf("%s: status %d, %v", name, status, out["error"])
	}
	result := out["result"].(map[string]any)
	if result["isError"] == true {
		return nil, result["content"].([]any)[0].(map[string]any)["text"].(string)
	}
	return result["structuredContent"].(map[string]any), ""
}

func newMCPEndpoint(t *testing.T) (serverEngineFixture, *mcpClient) {
	t.Helper()
	f := newServerEngineFixture(t)
	stop := f.driver.Start(context.Background(), 50*time.Millisecond, 16)
	t.Cleanup(stop)
	endpoint, err := mcpserver.New(mcpserver.Options{
		Matches: f.service, Engine: f.driver, Credentials: onlineauth.NewAllocator(f.authorizer), Authenticator: f.authorizer,
		ActiveGames: mcpserver.PostgresActiveGames(f.pool), AllowedOrigins: []string{"https://app.example"},
		Records:  agentboards.New(f.pool),
		MoveWait: 10 * time.Second, Poll: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	f.driver.SetReadiness(endpoint.PlayersReady)
	server := httptest.NewServer(endpoint)
	t.Cleanup(server.Close)
	client := &mcpClient{t: t, url: server.URL}
	if status, out := client.rpc("initialize", map[string]any{"protocolVersion": "2025-06-18", "clientInfo": map[string]any{"name": "test"}, "capabilities": map[string]any{}}); status != http.StatusOK || client.session == "" {
		t.Fatalf("initialize: %d %v", status, out)
	}
	return f, client
}

// An agent connects, plays Stockfish, gets its plan back, spends an illegal
// move and resigns, all through the remote endpoint.
func TestMCPAgentPlaysTheServerEngine(t *testing.T) {
	f, c := newMCPEndpoint(t)
	_, listed := c.rpc("tools/list", map[string]any{})
	names := []string{}
	for _, tool := range listed["result"].(map[string]any)["tools"].([]any) {
		names = append(names, tool.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "join_seat,get_rules,start_game,resume_game,get_board,make_move,wait_for_turn,resign" {
		t.Fatalf("tools = %v", names)
	}
	if _, errText := c.tool("make_move", map[string]any{"move": "e2e4"}); !strings.Contains(errText, "start_game") {
		t.Fatalf("a move without a game = %q", errText)
	}
	board, errText := c.tool("start_game", map[string]any{"model_name": "Test Model\u0000 @x", "color": "white", "engine_think_ms": 100, "minutes": 10, "increment_seconds": 0})
	if errText != "" {
		t.Fatal(errText)
	}
	if board["status"] != "your-turn" || board["yourSide"] != "white" || board["agentName"] != "Test Model x (self-reported)" || board["resume_token"] == "" {
		t.Fatalf("start_game = %v", board)
	}
	if board["input"].(map[string]any)["kind"] != "current-match-input" {
		t.Fatalf("no turn input: %v", board)
	}
	played, errText := c.tool("make_move", map[string]any{"move": "e2e4", "plan": "Take the centre."})
	if errText != "" {
		t.Fatal(errText)
	}
	after := played["board"].(map[string]any)
	if played["result"] != "accepted" || after["status"] != "your-turn" || after["moveCount"] != float64(2) {
		t.Fatalf("make_move = %v", played)
	}
	canonical, err := f.service.GetMatch(context.Background(), board["gameId"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if moves := after["input"].(map[string]any)["moves"]; moves != "e4 "+canonical.Moves[1].SAN {
		t.Fatalf("compact move history = %v", moves)
	}
	if plan := after["input"].(map[string]any)["previousThinking"].(map[string]any)["plan"]; plan != "Take the centre." {
		t.Fatalf("the plan did not come back: %v", plan)
	}
	if _, errText = c.tool("make_move", map[string]any{"move": "castle!"}); !strings.Contains(errText, "not a coordinate move") {
		t.Fatalf("a malformed move = %q", errText)
	}
	illegal, errText := c.tool("make_move", map[string]any{"move": "e1e5"})
	if errText != "" {
		t.Fatal(errText)
	}
	if illegal["result"] != "illegal" || !strings.Contains(illegal["message"].(string), "3 illegal attempts left") {
		t.Fatalf("an illegal move = %v", illegal)
	}
	resigned, errText := c.tool("resign", nil)
	if errText != "" || resigned["result"] != "resigned" || resigned["board"].(map[string]any)["status"] != "finished" {
		t.Fatalf("resign = %v, %q", resigned, errText)
	}
}

// The human's page asks make_move for no wait: the move intent returns as
// soon as the move is accepted, without holding the call for the opponent's
// reply. The reply keeps arriving through the watch poll, so the play screen
// behaves like a local game: the move commits immediately, premoves unlock
// while the opponent thinks, and the check highlight is not held back.
func TestMCPMakeMoveWithoutWaitReturnsAfterItsOwnMove(t *testing.T) {
	_, c := newMCPEndpoint(t)
	if _, errText := c.tool("start_game", map[string]any{"model_name": "Model", "engine_think_ms": 100}); errText != "" {
		t.Fatal(errText)
	}
	started := time.Now()
	played, errText := c.tool("make_move", map[string]any{"move": "e2e4", "wait_seconds": 0})
	if errText != "" {
		t.Fatal(errText)
	}
	after := played["board"].(map[string]any)
	if played["result"] != "accepted" || after["status"] != "opponent-turn" || after["moveCount"] != float64(1) {
		t.Fatalf("a no-wait move returned the reply anyway: %v", played)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("a no-wait move still waited %s", elapsed)
	}
	// The reply still lands for the same session on the next read.
	replied, errText := c.tool("wait_for_turn", nil)
	if errText != "" || replied["moveCount"] != float64(2) || replied["status"] != "your-turn" {
		t.Fatalf("the reply did not arrive: %v, %q", replied, errText)
	}
}

// Four illegal moves in one turn lose the game, as they do on the page.
func TestMCPFourIllegalMovesLose(t *testing.T) {
	_, c := newMCPEndpoint(t)
	if _, errText := c.tool("start_game", map[string]any{"model_name": "Model", "engine_think_ms": 100}); errText != "" {
		t.Fatal(errText)
	}
	var last map[string]any
	for range 4 {
		var errText string
		if last, errText = c.tool("make_move", map[string]any{"move": "a1a8"}); errText != "" {
			t.Fatal(errText)
		}
	}
	board := last["board"].(map[string]any)
	if !strings.Contains(last["message"].(string), "fourth illegal move") || board["status"] != "finished" || board["result"].(map[string]any)["outcome"] != "loss" {
		t.Fatalf("the fourth illegal move = %v", last)
	}
}

// A session that was lost (a restart, an expired session) re-attaches its
// game with the resume token, and a playing black agent gets Stockfish's
// first move.
func TestMCPResumeAndBlack(t *testing.T) {
	_, c := newMCPEndpoint(t)
	board, errText := c.tool("start_game", map[string]any{"model_name": "Model", "color": "black", "engine_think_ms": 100})
	if errText != "" {
		t.Fatal(errText)
	}
	if board["yourSide"] != "black" || board["status"] != "your-turn" || board["moveCount"] != float64(1) {
		t.Fatalf("a black start = %v", board)
	}
	token := board["resume_token"].(string)
	c.session = ""
	if status, _ := c.rpc("tools/list", map[string]any{}); status != http.StatusNotFound {
		t.Fatalf("a call without a session = %d, want 404", status)
	}
	c.rpc("initialize", map[string]any{"protocolVersion": "2025-06-18"})
	if _, errText = c.tool("resume_game", map[string]any{"resume_token": "kg_not-a-token"}); errText == "" {
		t.Fatal("a forged token resumed a game")
	}
	resumed, errText := c.tool("resume_game", map[string]any{"resume_token": token})
	if errText != "" || resumed["gameId"] != board["gameId"] || resumed["status"] != "your-turn" {
		t.Fatalf("resume = %v, %q", resumed, errText)
	}
	if played, errText := c.tool("make_move", map[string]any{"move": "e7e5"}); errText != "" || played["result"] != "accepted" {
		t.Fatalf("a move after resume = %v, %q", played, errText)
	}
}

// A browser on another site cannot drive the endpoint.
func TestMCPRefusesForeignOrigins(t *testing.T) {
	_, c := newMCPEndpoint(t)
	req, _ := http.NewRequest(http.MethodPost, c.url, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	req.Header.Set("Origin", "https://evil.example")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("a foreign origin = %d", res.StatusCode)
	}
}

// A game started with an invite code lands on the verified board; every
// other game is a community result. Aborted games are not scored, and a
// spent code stops verifying.
func TestMCPGamesFeedTheBoards(t *testing.T) {
	f, c := newMCPEndpoint(t)
	ctx := context.Background()
	store := agentboards.New(f.pool)
	_, code, err := store.IssueInvite(ctx, "runner test", 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, errText := c.tool("start_game", map[string]any{"model_name": "Model", "invite_code": "kinv_forged"}); !strings.Contains(errText, "not valid") {
		t.Fatalf("a forged code = %q", errText)
	}
	verified, errText := c.tool("start_game", map[string]any{"model_name": "Verified Model", "engine_think_ms": 100, "invite_code": code, "runner": "kamkm-runner/api"})
	if errText != "" || verified["board"] != "verified" {
		t.Fatalf("an invited game = %v, %q", verified, errText)
	}
	if _, errText = c.tool("resign", nil); errText != "" {
		t.Fatal(errText)
	}
	// The code had one use.
	if _, errText = c.tool("start_game", map[string]any{"model_name": "Verified Model", "invite_code": code}); !strings.Contains(errText, "not valid") {
		t.Fatalf("a spent code = %q", errText)
	}
	community, errText := c.tool("start_game", map[string]any{"model_name": "Community Model", "engine_think_ms": 5000})
	if errText != "" || community["board"] != "community" {
		t.Fatalf("a community game = %v, %q", community, errText)
	}
	if _, errText = c.tool("resign", nil); errText != "" {
		t.Fatal(errText)
	}
	verifiedBoard, err := store.Read(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(verifiedBoard.Rows) != 1 || verifiedBoard.Rows[0] != (agentboards.Row{Model: "Verified Model", Level: "casual", Games: 1, Losses: 1}) {
		t.Fatalf("verified board = %+v", verifiedBoard.Rows)
	}
	communityBoard, err := store.Read(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(communityBoard.Rows) != 1 || communityBoard.Rows[0].Model != "Community Model" || communityBoard.Rows[0].Level != "strong" || communityBoard.Rows[0].Losses != 1 {
		t.Fatalf("community board = %+v", communityBoard.Rows)
	}
	// The public route serves the same rows.
	server := httptest.NewServer(agentboards.Handler(store, time.Second))
	defer server.Close()
	res, err := http.Get(server.URL + "?board=verified")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var served agentboards.Board
	if err = json.NewDecoder(res.Body).Decode(&served); err != nil || served.Board != "verified" || len(served.Rows) != 1 {
		t.Fatalf("served board = %+v, %v", served, err)
	}
}
