//go:build onlinefixture

// Regression tests for the local online fixture.
//
// The fixture must never report itself ready when one of its servers is not
// serving. A fixture that answers "ready" while its identity document is dead
// produces a false pass: every authenticated request fails later and the
// harness blames the application.

package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net"
	"net/http"
	"testing"
	"time"
)

func testKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// The JWKS server must serve the document over HTTPS with the fixture's own
// certificate. This is the case that failed when the certificate was not
// carried by the server.
func TestJWKSServerServesTheDocumentOverTLS(t *testing.T) {
	key := testKey(t)
	_, pool, keyPair, err := loopbackCertificate(key)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(loopbackHost, "0"))
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(jwksDocument(key))
		}),
		TLSConfig: tlsConfig(keyPair),
	}
	failure := make(chan error, 1)
	go func() {
		if err := server.ServeTLS(listener, "", ""); err != nil && err != http.ErrServerClosed {
			failure <- err
		}
	}()
	defer func() { _ = server.Close() }()

	url := "https://" + listener.Addr().String() + "/.well-known/jwks.json"
	client := &http.Client{
		Timeout:   5 * time.Second,
		Transport: &http.Transport{TLSClientConfig: tlsClientConfig(pool)},
	}
	if err := waitForJWKS(context.Background(), client, url, failure); err != nil {
		t.Fatalf("the fixture identity document was not served: %v", err)
	}
}

// A dead identity server must fail the readiness check instead of producing a
// ready fixture.
func TestReadinessRefusesADeadIdentityServer(t *testing.T) {
	key := testKey(t)
	_, pool, _, err := loopbackCertificate(key)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(loopbackHost, "0"))
	if err != nil {
		t.Fatal(err)
	}
	// A server without a certificate cannot serve TLS. This is the failure
	// mode the fixture must never survive.
	server := &http.Server{Handler: http.NotFoundHandler()}
	failure := make(chan error, 1)
	go func() {
		if err := server.ServeTLS(listener, "", ""); err != nil && err != http.ErrServerClosed {
			failure <- err
		}
	}()
	defer func() { _ = server.Close() }()

	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: &http.Transport{TLSClientConfig: tlsClientConfig(pool)},
	}
	url := "https://" + listener.Addr().String() + "/.well-known/jwks.json"
	if err := waitForJWKS(context.Background(), client, url, failure); err == nil {
		t.Fatal("the readiness check accepted a fixture whose identity server does not serve")
	}
}

// An API that never answers must fail the readiness check.
func TestReadinessRefusesAnUnreachableAPI(t *testing.T) {
	listener, err := net.Listen("tcp", net.JoinHostPort(loopbackHost, "0"))
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := waitForAPI(ctx, "http://"+address); err == nil {
		t.Fatal("the readiness check accepted an API that does not answer")
	}
}
