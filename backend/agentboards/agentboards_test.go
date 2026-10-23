package agentboards

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestLevelBucketsTheThinkTime(t *testing.T) {
	for thinkMs, want := range map[int]string{100: "casual", 499: "casual", 500: "club", 1000: "club", 3000: "strong", 10000: "strong"} {
		if got := Level(thinkMs); got != want {
			t.Errorf("Level(%d) = %q, want %q", thinkMs, got, want)
		}
	}
}

type countingReader struct{ reads map[bool]int }

func (r *countingReader) Read(_ context.Context, verified bool) (Board, error) {
	r.reads[verified]++
	board := "community"
	if verified {
		board = "verified"
	}
	return Board{Board: board, Rows: []Row{}}, nil
}

func TestHandlerCachesEachBoardAndServesOnlyGet(t *testing.T) {
	reader := &countingReader{reads: map[bool]int{}}
	handler := Handler(reader, time.Minute)
	get := func(query string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/public/agent-boards"+query, nil))
		return recorder
	}
	for range 3 {
		if code := get("?board=verified").Code; code != http.StatusOK {
			t.Fatalf("verified board answered %d", code)
		}
	}
	if body := get("?board=anything").Body.String(); !strings.Contains(body, `"board":"community"`) {
		t.Fatalf("an unknown board is not the community board: %s", body)
	}
	if reader.reads[true] != 1 || reader.reads[false] != 1 {
		t.Fatalf("the boards were read %v times, want once each", reader.reads)
	}
	post := httptest.NewRecorder()
	handler.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/v1/public/agent-boards", nil))
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST answered %d", post.Code)
	}
}
