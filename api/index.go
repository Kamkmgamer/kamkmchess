// Package handler is the Vercel entry point for the optional account storage API.
package handler

import (
	"context"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
)

var service struct {
	sync.Mutex
	handler http.Handler
}

func Handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	// Provisioning an environment must not silently enable public account storage.
	if os.Getenv("CLOUD_STORAGE_ENABLED") != "true" {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"account_storage_disabled"}`))
		return
	}
	handler, err := activeHandler()
	if err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":"storage_unavailable"}`))
		return
	}
	request := r.Clone(r.Context())
	if r.URL.Path == "/api/index" || r.URL.Path == "/api/index.go" {
		path := r.URL.Query().Get("path")
		if path == "" || strings.ContainsAny(path, "\\?#") || strings.Contains(path, "..") {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not_found"}`))
			return
		}
		request.URL.Path = "/v1/" + strings.TrimPrefix(path, "/")
		request.URL.RawPath = ""
		query := request.URL.Query()
		query.Del("path")
		request.URL.RawQuery = query.Encode()
	}
	handler.ServeHTTP(w, request)
}

func activeHandler() (http.Handler, error) {
	service.Lock()
	defer service.Unlock()
	if service.handler != nil {
		return service.handler, nil
	}
	cfg, err := serverapp.Load(os.Getenv)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	handler, _, err := serverapp.Open(ctx, cfg)
	if err != nil {
		return nil, err
	}
	service.handler = handler
	return handler, nil
}
