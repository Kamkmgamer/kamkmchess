// Package mcpserver is the anonymous remote MCP endpoint. An agent that
// connects plays the server engine through the same tools the page offers
// (get_rules, start_game, get_board, make_move, wait_for_turn, resign).
//
// The transport is MCP Streamable HTTP with plain JSON answers: every
// request is one POST of one JSON-RPC message, and the server never opens a
// stream. A session is kept in memory. A restarted server forgets it, so
// start_game also returns a resume token that re-attaches the game.
package mcpserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
)

// ProtocolVersions are the MCP revisions the endpoint answers. The first is
// offered when a client asks for one the endpoint does not know.
var ProtocolVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

const sessionHeader = "Mcp-Session-Id"

// maxBody bounds one request.
const maxBody = 64 << 10

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// The JSON-RPC error codes the endpoint uses.
const (
	codeParse          = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
)

// ServeHTTP answers one MCP message.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// A browser page must never drive the endpoint from another site. MCP
	// clients do not send an Origin, and an allowed one is the site itself.
	if origin := r.Header.Get("Origin"); origin != "" && !slices.Contains(s.options.AllowedOrigins, origin) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, MCP-Protocol-Version")
		w.Header().Set("Access-Control-Expose-Headers", sessionHeader)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == http.MethodGet && r.URL.Query().Has("watch") {
		s.watch(w, r)
		return
	}
	switch r.Method {
	case http.MethodPost:
	case http.MethodDelete:
		s.sessions.drop(r.Header.Get(sessionHeader))
		w.WriteHeader(http.StatusNoContent)
		return
	default:
		// No server-initiated stream is offered.
		w.Header().Set("Allow", "POST, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(raw) > maxBody {
		writeJSON(w, http.StatusRequestEntityTooLarge, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{codeInvalidRequest, "request too large"}})
		return
	}
	var req rpcRequest
	if err = json.Unmarshal(raw, &req); err != nil || req.JSONRPC != "2.0" || req.Method == "" {
		writeJSON(w, http.StatusBadRequest, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{codeParse, "expected one JSON-RPC 2.0 message"}})
		return
	}
	// A notification has no id and gets no answer.
	if len(req.ID) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if req.Method == "initialize" {
		s.initialize(w, req)
		return
	}
	sess, ok := s.sessions.get(r.Header.Get(sessionHeader))
	if !ok {
		// The spec answers an unknown session with 404, which tells the
		// client to initialize again.
		writeJSON(w, http.StatusNotFound, rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{codeInvalidRequest, "unknown or expired session: initialize again"}})
		return
	}
	switch req.Method {
	case "ping":
		writeJSON(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: struct{}{}})
	case "tools/list":
		writeJSON(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{"tools": toolList()}})
	case "tools/call":
		var params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err = json.Unmarshal(req.Params, &params); err != nil || params.Name == "" {
			writeJSON(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{codeInvalidParams, "tools/call needs a name"}})
			return
		}
		result, err := s.call(r.Context(), sess, clientAddress(r, s.options.TrustProxy), params.Name, params.Arguments)
		writeJSON(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: toolResult(result, err)})
	default:
		writeJSON(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{codeMethodNotFound, "method not found: " + req.Method}})
	}
}

func (s *Server) initialize(w http.ResponseWriter, req rpcRequest) {
	var params struct {
		ProtocolVersion string `json:"protocolVersion"`
		ClientInfo      struct {
			Name string `json:"name"`
		} `json:"clientInfo"`
	}
	_ = json.Unmarshal(req.Params, &params)
	version := ProtocolVersions[0]
	if slices.Contains(ProtocolVersions, params.ProtocolVersion) {
		version = params.ProtocolVersion
	}
	id, err := s.sessions.create()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{codeInvalidRequest, err.Error()}})
		return
	}
	w.Header().Set(sessionHeader, id)
	writeJSON(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{
		"protocolVersion": version,
		"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
		"serverInfo":      map[string]any{"name": "kamkm-chess", "title": "kamkm chess", "version": "1"},
		"instructions":    Instructions,
	}})
}

// toolResult wraps a tool answer. A failure is a tool error the model reads,
// not a protocol error.
func toolResult(result any, err error) map[string]any {
	if err != nil {
		return map[string]any{"content": []map[string]any{{"type": "text", "text": err.Error()}}, "isError": true}
	}
	text, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		return map[string]any{"content": []map[string]any{{"type": "text", "text": "internal error"}}, "isError": true}
	}
	return map[string]any{
		// Structured content carries the complete machine-readable answer. The
		// text fallback stays short for board results so MCP hosts that retain
		// both representations do not duplicate the full position history.
		"content":           []map[string]any{{"type": "text", "text": toolResultText(result, string(text))}},
		"structuredContent": result,
	}
}

func toolResultText(result any, fallback string) string {
	record, ok := result.(map[string]any)
	if !ok {
		return fallback
	}
	// Initial game results include private invitations and recovery tokens.
	// Preserve them for MCP clients that consume only text content.
	if record["resume_token"] != nil || record["opponent_url"] != nil {
		return fallback
	}
	if message, ok := record["message"].(string); ok {
		if outcome, ok := record["result"].(string); ok {
			return fmt.Sprintf("%s: %s", outcome, message)
		}
		return message
	}
	if status, ok := record["status"].(string); ok {
		if fen, ok := record["fen"].(string); ok {
			return fmt.Sprintf("status=%s fen=%s watch_url=%v", status, fen, record["watch_url"])
		}
		return "status=" + status
	}
	return fallback
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// clientAddress names the caller for the rate limits. The hosting proxy
// appends the address it saw to X-Forwarded-For and keeps whatever the client
// sent, so only the last entry is trustworthy.
func clientAddress(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if values := r.Header.Values("X-Forwarded-For"); len(values) > 0 {
			last := values[len(values)-1]
			if i := strings.LastIndex(last, ","); i >= 0 {
				last = last[i+1:]
			}
			if last = strings.TrimSpace(last); last != "" {
				return last
			}
		}
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i > 0 {
		host = host[:i]
	}
	return host
}

// errTool is a readable failure of a tool call.
func errTool(message string) error { return errors.New(message) }
