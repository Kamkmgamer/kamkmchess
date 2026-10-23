package serverapp

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAClosedSurfaceAnswersLikeAnUnmountedOne(t *testing.T) {
	open := false
	handler := whenOpen(func() bool { return open }, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	serve := func() int {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/online/queue/entries", nil))
		return recorder.Code
	}
	if code := serve(); code != http.StatusNotFound {
		t.Fatalf("a closed queue answered %d", code)
	}
	open = true
	if code := serve(); code != http.StatusTeapot {
		t.Fatalf("an opened queue answered %d", code)
	}
}
