package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDisabledStorageDoesNotInitializeOrExposeConfiguration(t *testing.T) {
	t.Setenv("CLOUD_STORAGE_ENABLED", "false")
	t.Setenv("DATABASE_URL", "private-canary")
	w := httptest.NewRecorder()
	Handler(w, httptest.NewRequest(http.MethodGet, "/api/index?path=games", nil))
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Cache-Control") != "no-store" || strings.Contains(w.Body.String(), "private-canary") {
		t.Fatalf("unexpected disabled response: %d %s", w.Code, w.Body.String())
	}
}

func TestHostedRewritePreservesMethodBodyAndPagination(t *testing.T) {
	t.Setenv("CLOUD_STORAGE_ENABLED", "true")
	service.Lock()
	previous := service.handler
	service.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/games/game-1/commit" || r.Method != http.MethodPost || r.URL.Query().Get("after") != "7" || r.URL.Query().Has("path") || r.Header.Get("Authorization") != "Bearer fixture" {
			t.Errorf("rewrite lost request: %s %s", r.Method, r.URL)
		}
		w.WriteHeader(http.StatusAccepted)
	})
	service.Unlock()
	t.Cleanup(func() { service.Lock(); service.handler = previous; service.Unlock() })
	r := httptest.NewRequest(http.MethodPost, "/api/index?path=games/game-1/commit&after=7", strings.NewReader(`{"operationId":"fixture"}`))
	r.Header.Set("Authorization", "Bearer fixture")
	w := httptest.NewRecorder()
	Handler(w, r)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status %d", w.Code)
	}
}
