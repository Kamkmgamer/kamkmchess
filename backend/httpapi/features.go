package httpapi

import (
	"context"
	"net/http"
)

// OnlineFeatures is the rollout state of the two online surfaces.
//
// The service owns the rollout. The browser asks the service once and keeps
// the answer for the page lifetime. A configured service origin is not an
// enablement signal: a production account build already has one.
type OnlineFeatures struct {
	// Friends opens the friend invitation, link join and rematch surface.
	Friends bool `json:"friends"`
	// Queue opens the public matchmaking surface.
	Queue bool `json:"queue"`
	// MCP reports that the remote MCP endpoint is mounted, so the page can
	// offer its connection prompts.
	MCP bool `json:"mcp"`
}

// NewFeatures returns the feature state route.
//
// The route is always mounted, even when both surfaces are closed, because
// the browser asks it before it shows anything. The answer carries exactly
// the two independent play switches and whether the remote MCP endpoint is
// mounted.
func NewFeatures(features OnlineFeatures) http.Handler {
	return NewLiveFeatures(func(context.Context) OnlineFeatures { return features })
}

// NewLiveFeatures is NewFeatures for switches that can change while the
// process runs: every answer reads the current state.
func NewLiveFeatures(current func(context.Context) OnlineFeatures) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/online/features", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, current(r.Context()))
	})
	return mux
}
