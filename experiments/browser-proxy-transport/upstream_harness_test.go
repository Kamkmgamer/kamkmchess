package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	configaccess "github.com/router-for-me/CLIProxyAPI/v8/internal/access/config_access"
	sdkaccess "github.com/router-for-me/CLIProxyAPI/v8/sdk/access"
	sdkconfig "github.com/router-for-me/CLIProxyAPI/v8/sdk/config"
)

// Copy this file into internal/api in the pinned, disposable upstream checkout.
// It runs real upstream CORS/auth middleware. Both API handlers below are
// synthetic. No service, provider executor, OAuth store, or upstream client is
// constructed, and no request is forwarded to a model.
func TestKHA15TransportHarness(t *testing.T) {
	const syntheticKey = "kha15-synthetic-only-no-provider"
	assetDir := os.Getenv("KHA15_ASSET_DIR")
	logPath := os.Getenv("KHA15_LOG_FILE")
	readyPath := os.Getenv("KHA15_READY_FILE")
	if assetDir == "" || logPath == "" || readyPath == "" {
		t.Fatal("KHA15_ASSET_DIR, KHA15_LOG_FILE and KHA15_READY_FILE are required")
	}
	gin.SetMode(gin.ReleaseMode)
	configaccess.Register(&sdkconfig.SDKConfig{APIKeys: []string{syntheticKey}})
	manager := sdkaccess.NewManager()
	manager.SetProviders(sdkaccess.RegisteredProviders())
	if len(manager.Providers()) != 1 {
		t.Fatal("expected exactly the synthetic config-access provider")
	}
	router := gin.New()
	router.Use(corsMiddleware())
	router.GET("/harness", func(c *gin.Context) { c.File(filepath.Join(assetDir, "probe.html")) })
	router.GET("/probe.js", func(c *gin.Context) { c.File(filepath.Join(assetDir, "probe.js")) })
	v1 := router.Group("/v1", AuthMiddleware(manager))
	v1.GET("/models", func(c *gin.Context) {
		c.JSON(200, gin.H{"object": "list", "synthetic": true, "data": []gin.H{{"id": "kha15-synthetic", "object": "model", "owned_by": "transport-fixture"}}})
	})
	v1.POST("/chat/completions", func(c *gin.Context) {
		var body struct {
			Stream bool `json:"stream"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 65536)).Decode(&body); err != nil {
			c.JSON(400, gin.H{"synthetic": true, "error": "invalid fixture JSON"})
			return
		}
		if body.Stream {
			c.Header("Content-Type", "text/event-stream")
			c.Status(200)
			fmt.Fprint(c.Writer, "data: {\"id\":\"kha15-fixture\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"{\\\"move\\\":\\\"e2e4\\\"}\"},\"finish_reason\":null}]}\n\n")
			fmt.Fprint(c.Writer, "data: {\"id\":\"kha15-fixture\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			return
		}
		c.JSON(200, gin.H{"id": "kha15-fixture", "object": "chat.completion", "synthetic": true, "choices": []gin.H{{"index": 0, "message": gin.H{"role": "assistant", "content": "{\"move\":\"e2e4\"}"}, "finish_reason": "stop"}}})
	})

	var mu sync.Mutex
	var records []map[string]any
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		originalPath := r.URL.Path
		explicit := strings.HasPrefix(originalPath, "/explicit/")
		restricted := strings.HasPrefix(originalPath, "/restricted/")
		blockedOrigin := strings.HasPrefix(originalPath, "/blocked-origin/")
		if explicit || restricted || blockedOrigin {
			r = r.Clone(r.Context())
			prefix := "/explicit"
			if restricted {
				prefix = "/restricted"
			}
			if blockedOrigin {
				prefix = "/blocked-origin"
			}
			r.URL.Path = strings.TrimPrefix(originalPath, prefix)
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, r)
		// This controlled gateway variant changes only the allowed-header list.
		// The baseline response comes unchanged from the pinned middleware.
		if explicit {
			recorder.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key, ngrok-skip-browser-warning")
		}
		if restricted {
			recorder.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, ngrok-skip-browser-warning")
		}
		if blockedOrigin {
			recorder.Header().Set("Access-Control-Allow-Origin", "https://not-the-test-origin.invalid")
		}
		cors := map[string]string{}
		for key, values := range recorder.Header() {
			for _, value := range values {
				w.Header().Add(key, value)
			}
			if strings.HasPrefix(http.CanonicalHeaderKey(key), "Access-Control-") {
				cors[key] = strings.Join(values, ", ")
			}
		}
		w.WriteHeader(recorder.Code)
		_, _ = w.Write(recorder.Body.Bytes())
		record := map[string]any{
			"utc": time.Now().UTC().Format(time.RFC3339Nano), "method": r.Method,
			"path": originalPath, "case": r.URL.Query().Get("case"), "origin": r.Header.Get("Origin"),
			"access_control_request_method":          r.Header.Get("Access-Control-Request-Method"),
			"access_control_request_headers":         r.Header.Get("Access-Control-Request-Headers"),
			"access_control_request_private_network": r.Header.Get("Access-Control-Request-Private-Network"),
			"authorization_present":                  r.Header.Get("Authorization") != "", "x_api_key_present": r.Header.Get("X-Api-Key") != "",
			"status": recorder.Code, "response_cors": cors, "synthetic_handlers_only": true,
		}
		mu.Lock()
		defer mu.Unlock()
		records = append(records, record)
		file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if err == nil {
			_ = json.NewEncoder(file).Encode(record)
			_ = file.Close()
		}
	})

	stop := make(chan struct{})
	var stopOnce sync.Once
	control := http.NewServeMux()
	control.HandleFunc("/records", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(records)
	})
	control.HandleFunc("/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		w.WriteHeader(204)
		stopOnce.Do(func() { close(stop) })
	})
	mainListener, err := net.Listen("tcp", "127.0.0.1:18765")
	if err != nil {
		t.Fatal(err)
	}
	controlListener, err := net.Listen("tcp", "127.0.0.1:18766")
	if err != nil {
		_ = mainListener.Close()
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	controlServer := &http.Server{Handler: control, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = server.Serve(mainListener) }()
	go func() { _ = controlServer.Serve(controlListener) }()
	ready := map[string]any{"pid": os.Getpid(), "http": "http://127.0.0.1:18765", "control": "http://127.0.0.1:18766", "upstream_commit": "5be2cdab0869cbaa3d401891f740aebf7e15aa99", "synthetic_handlers_only": true}
	readyBytes, _ := json.MarshalIndent(ready, "", "  ")
	if err := os.WriteFile(readyPath, readyBytes, 0600); err != nil {
		t.Fatal(err)
	}
	fmt.Printf("KHA15_READY %s\n", readyBytes)
	select {
	case <-stop:
	case <-time.After(25 * time.Minute):
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	_ = controlServer.Shutdown(ctx)
}
