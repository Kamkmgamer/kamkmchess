// Package httpapi exposes the owner-scoped, versioned game storage API.
package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/storage"
)

const maxBody = 8 << 20

type Store interface {
	Create(ctx context.Context, ownerID string, input storage.CreateGame) (storage.Game, error)
	Get(ctx context.Context, ownerID, gameID string) (storage.Game, error)
	List(ctx context.Context, ownerID string, page storage.Page) (storage.GamePage, error)
	ReadArchives(ctx context.Context, ownerID, gameID string, afterSequence int64, limit int) ([]storage.ArchiveChunk, error)
	ReadEvents(ctx context.Context, ownerID, gameID string, afterSequence int64, limit int) ([]storage.ArchiveEvent, error)
	ReadArchiveBatch(ctx context.Context, ownerID, gameID string) ([]byte, error)
	Commit(ctx context.Context, ownerID string, req storage.CommitRequest) (storage.CommitResult, error)
	Takeover(ctx context.Context, ownerID string, req storage.CASRequest) (storage.Game, error)
	Delete(ctx context.Context, ownerID string, req storage.CASRequest) error
	LookupOperation(ctx context.Context, ownerID, gameID, operationID string) (storage.Operation, error)
}

type API struct{ store Store }

func New(store Store) http.Handler {
	api := &API{store: store}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/games", api.list)
	mux.HandleFunc("POST /v1/games", api.create)
	mux.HandleFunc("GET /v1/games/{gameID}", api.get)
	mux.HandleFunc("GET /v1/games/{gameID}/archives", api.archives)
	mux.HandleFunc("GET /v1/games/{gameID}/events", api.events)
	mux.HandleFunc("GET /v1/games/{gameID}/archive-batch", api.archiveBatch)
	mux.HandleFunc("DELETE /v1/games/{gameID}", api.delete)
	mux.HandleFunc("POST /v1/games/{gameID}/commit", api.commit)
	mux.HandleFunc("POST /v1/games/{gameID}/takeover", api.takeover)
	mux.HandleFunc("GET /v1/games/{gameID}/operations/{operationID}", api.operation)
	return mux
}

// NewAuthenticated installs Clerk verification before any handler can read an
// owner identifier from context. Production entry points should use this.
func NewAuthenticated(store Store, verifier *auth.Verifier) http.Handler {
	return verifier.Middleware(New(store))
}

// NewAuthenticatedWithFence installs Clerk verification and the account fence
// of the private store.
//
// The verification runs first, because the fence needs the verified owner of
// the request. The fence then refuses the private requests of a deleted
// account, so an old session token cannot read or write the private archive of
// an account whose data was removed.
func NewAuthenticatedWithFence(store Store, verifier *auth.Verifier, fence AccountFence) http.Handler {
	return verifier.Middleware(WithAccountFence(fence, New(store)))
}

func (a *API) list(w http.ResponseWriter, r *http.Request) {
	owner, ok := auth.Owner(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	limit := 50
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 100 {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		limit = parsed
	}
	page, err := a.store.List(r.Context(), owner, storage.Page{Limit: limit, After: r.URL.Query().Get("after")})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items := make([]gameResponse, 0, len(page.Games))
	for _, g := range page.Games {
		items = append(items, toGame(g))
	}
	writeJSON(w, http.StatusOK, map[string]any{"games": items, "next": page.Next})
}

func (a *API) create(w http.ResponseWriter, r *http.Request) {
	owner, ok := auth.Owner(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		GameID     string          `json:"gameId"`
		Checkpoint json.RawMessage `json:"checkpoint"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.GameID == "" || len(body.Checkpoint) == 0 || !json.Valid(body.Checkpoint) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	g, err := a.store.Create(r.Context(), owner, storage.CreateGame{GameID: body.GameID, CheckpointJSON: body.Checkpoint})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, toGame(g))
}

func (a *API) get(w http.ResponseWriter, r *http.Request) {
	owner, ok := auth.Owner(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	g, err := a.store.Get(r.Context(), owner, r.PathValue("gameID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toGame(g))
}

func (a *API) archives(w http.ResponseWriter, r *http.Request) {
	owner, ok := auth.Owner(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	after := int64(-1)
	if value := r.URL.Query().Get("after"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < -1 {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		after = parsed
	}
	limit := 100
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 500 {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		limit = parsed
	}
	chunks, err := a.store.ReadArchives(r.Context(), owner, r.PathValue("gameID"), after, limit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items := make([]archiveChunkResponse, 0, len(chunks))
	for _, chunk := range chunks {
		if !json.Valid(chunk.RawJSON) {
			writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
			return
		}
		items = append(items, archiveChunkResponse{Sequence: chunk.Sequence, Raw: json.RawMessage(chunk.RawJSON), SHA256: chunk.SHA256})
	}
	var nextAfter *int64
	if len(chunks) == limit {
		next := chunks[len(chunks)-1].Sequence
		nextAfter = &next
	}
	writeJSON(w, http.StatusOK, map[string]any{"archives": items, "nextAfter": nextAfter})
}

func (a *API) events(w http.ResponseWriter, r *http.Request) {
	owner, ok := auth.Owner(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	after, limit, ok := archiveCursor(w, r)
	if !ok {
		return
	}
	events, err := a.store.ReadEvents(r.Context(), owner, r.PathValue("gameID"), after, limit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	items := make([]json.RawMessage, 0, len(events))
	for _, event := range events {
		if !json.Valid(event.RawJSON) {
			writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
			return
		}
		items = append(items, json.RawMessage(event.RawJSON))
	}
	var nextAfter *int64
	if len(events) == limit {
		next := events[len(events)-1].Sequence
		nextAfter = &next
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": items, "nextAfter": nextAfter})
}

func (a *API) archiveBatch(w http.ResponseWriter, r *http.Request) {
	owner, ok := auth.Owner(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	raw, err := a.store.ReadArchiveBatch(r.Context(), owner, r.PathValue("gameID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, raw)
}

func archiveCursor(w http.ResponseWriter, r *http.Request) (int64, int, bool) {
	after := int64(-1)
	if value := r.URL.Query().Get("after"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < -1 {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return 0, 0, false
		}
		after = parsed
	}
	limit := 100
	if value := r.URL.Query().Get("limit"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 500 {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return 0, 0, false
		}
		limit = parsed
	}
	return after, limit, true
}

func (a *API) commit(w http.ResponseWriter, r *http.Request) {
	owner, ok := auth.Owner(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		OperationID      string          `json:"operationId"`
		ExpectedRevision int64           `json:"expectedRevision"`
		ExpectedEpoch    int64           `json:"expectedEpoch"`
		Checkpoint       json.RawMessage `json:"checkpoint"`
		ArchiveBatch     json.RawMessage `json:"archiveBatch"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.OperationID == "" || body.ExpectedRevision <= 0 || body.ExpectedEpoch <= 0 || len(body.Checkpoint) == 0 || !json.Valid(body.Checkpoint) || len(body.ArchiveBatch) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	events, archives, err := parseArchiveBatch(body.ArchiveBatch, r.PathValue("gameID"), body.ExpectedRevision, body.ExpectedEpoch, body.Checkpoint)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	result, err := a.store.Commit(r.Context(), owner, storage.CommitRequest{GameID: r.PathValue("gameID"), OperationID: body.OperationID, ExpectedRevision: body.ExpectedRevision, ExpectedEpoch: body.ExpectedEpoch, CheckpointJSON: body.Checkpoint, Archives: archives, Events: events})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	operation, err := safeOperation(result.Operation)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"game": toGame(result.Game), "operation": operation, "duplicate": result.Duplicate})
}

func (a *API) takeover(w http.ResponseWriter, r *http.Request) {
	owner, ok := auth.Owner(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		ExpectedRevision int64 `json:"expectedRevision"`
		ExpectedEpoch    int64 `json:"expectedEpoch"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.ExpectedRevision <= 0 || body.ExpectedEpoch <= 0 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	g, err := a.store.Takeover(r.Context(), owner, storage.CASRequest{GameID: r.PathValue("gameID"), ExpectedRevision: body.ExpectedRevision, ExpectedEpoch: body.ExpectedEpoch})
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toGame(g))
}

func (a *API) delete(w http.ResponseWriter, r *http.Request) {
	owner, ok := auth.Owner(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		ExpectedRevision int64 `json:"expectedRevision"`
		ExpectedEpoch    int64 `json:"expectedEpoch"`
	}
	if !decodeBody(w, r, &body) {
		return
	}
	if body.ExpectedRevision <= 0 || body.ExpectedEpoch <= 0 {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if err := a.store.Delete(r.Context(), owner, storage.CASRequest{GameID: r.PathValue("gameID"), ExpectedRevision: body.ExpectedRevision, ExpectedEpoch: body.ExpectedEpoch}); err != nil {
		writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) operation(w http.ResponseWriter, r *http.Request) {
	owner, ok := auth.Owner(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	op, err := a.store.LookupOperation(r.Context(), owner, r.PathValue("gameID"), r.PathValue("operationID"))
	if err != nil {
		writeStoreError(w, err)
		return
	}
	response, err := safeOperation(op)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func safeOperation(op storage.Operation) (map[string]any, error) {
	response := map[string]any{"id": op.ID, "gameId": op.GameID, "revision": op.Revision, "epoch": op.Epoch, "acceptedAt": op.AcceptedAt}
	if len(op.ResultJSON) == 0 {
		return response, nil
	}
	var storedFields map[string]json.RawMessage
	if json.Unmarshal(op.ResultJSON, &storedFields) != nil {
		return nil, errors.New("invalid stored operation result")
	}
	if len(storedFields) == 0 {
		return response, nil
	}
	var game storage.Game
	if err := json.Unmarshal(op.ResultJSON, &game); err != nil || !json.Valid(game.CheckpointJSON) {
		return nil, errors.New("invalid stored operation result")
	}
	encoded, err := json.Marshal(toGame(game))
	if err != nil {
		return nil, err
	}
	response["result"] = json.RawMessage(encoded)
	return response, nil
}

type gameResponse struct {
	ID         string          `json:"id"`
	Revision   int64           `json:"revision"`
	Epoch      int64           `json:"epoch"`
	Checkpoint json.RawMessage `json:"checkpoint"`
	CreatedAt  time.Time       `json:"createdAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
	DeletedAt  *time.Time      `json:"deletedAt,omitempty"`
}

type archiveChunkResponse struct {
	Sequence int64           `json:"sequence"`
	Raw      json.RawMessage `json:"raw"`
	SHA256   string          `json:"sha256"`
}

func toGame(g storage.Game) gameResponse {
	return gameResponse{ID: g.ID, Revision: g.Revision, Epoch: g.Epoch, Checkpoint: json.RawMessage(g.CheckpointJSON), CreatedAt: g.CreatedAt, UpdatedAt: g.UpdatedAt, DeletedAt: g.DeletedAt}
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any) bool {
	if r.ContentLength > maxBody {
		writeError(w, http.StatusRequestEntityTooLarge, "request_too_large")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBody)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "request_too_large")
		} else {
			writeError(w, http.StatusBadRequest, "invalid_request")
		}
		return false
	}
	if !uniqueJSON(raw) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	if !exactBodyFieldNames(raw, target) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	return true
}

func exactBodyFieldNames(raw []byte, target any) bool {
	typeOf := reflect.TypeOf(target)
	if typeOf == nil || typeOf.Kind() != reflect.Pointer || typeOf.Elem().Kind() != reflect.Struct {
		return false
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return false
	}
	fields := make(map[string]struct{}, typeOf.Elem().NumField())
	for i := 0; i < typeOf.Elem().NumField(); i++ {
		field := typeOf.Elem().Field(i)
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "" {
			name = field.Name
		}
		if name != "-" {
			fields[name] = struct{}{}
		}
	}
	for key := range object {
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	return true
}

func uniqueJSON(raw []byte) bool {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if consumeJSONValue(d) != nil {
		return false
	}
	_, err := d.Token()
	return err == io.EOF
}

func consumeJSONValue(d *json.Decoder) error {
	t, err := d.Token()
	if err != nil {
		return err
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]struct{}{}
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok {
				return errors.New("invalid JSON object key")
			}
			if _, exists := seen[name]; exists {
				return errors.New("duplicate JSON object key")
			}
			seen[name] = struct{}{}
			if err := consumeJSONValue(d); err != nil {
				return err
			}
		}
		_, err = d.Token()
		return err
	case '[':
		for d.More() {
			if err := consumeJSONValue(d); err != nil {
				return err
			}
		}
		_, err = d.Token()
		return err
	default:
		return errors.New("invalid JSON delimiter")
	}
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found")
	case errors.Is(err, storage.ErrAlreadyExists), errors.Is(err, storage.ErrConflict), errors.Is(err, storage.ErrOperationReuse):
		writeError(w, http.StatusConflict, "conflict")
	case errors.Is(err, storage.ErrInvalidDTO), errors.Is(err, storage.ErrInvalidArgument):
		writeError(w, http.StatusBadRequest, "invalid_request")
	case errors.Is(err, storage.ErrDeleted):
		writeError(w, http.StatusGone, "deleted")
	default:
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
	}
}
func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeRawJSON(w http.ResponseWriter, status int, raw []byte) {
	if !json.Valid(raw) {
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
