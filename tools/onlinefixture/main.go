//go:build onlinefixture

// Command onlinefixture runs the real online service composition against a
// throwaway PostgreSQL schema so a browser can drive it end to end.
//
// It exists for local and CI integration runs only. The build tag keeps it out
// of every production binary: `go build ./...` never compiles this file, and
// the deployed API image never contains it.
//
// What it does:
//
//   - generates a fresh RSA signing key and a self-signed loopback certificate;
//   - serves the JWKS document the API's own verifier fetches, over HTTPS on
//     127.0.0.1, so no hosted identity provider is contacted;
//   - creates an isolated schema, applies the checked-in migrations to it and
//     points the service pool's search_path at that schema;
//   - composes the production service with serverapp.Open, so the routes,
//     authorization, deadline reconciler and private rules worker are the real
//     ones;
//   - writes a descriptor with the base URL, the issuer and short-lived
//     synthetic session tokens for the test accounts.
//
// It never writes to a hosted database: it refuses a database URL whose host
// is not loopback unless --allow-remote-database is passed, it refuses to
// reuse an existing schema, and it drops the schema it created on shutdown.
//
// Usage:
//
//	go run -tags onlinefixture ./tools/onlinefixture \
//	  --database-url "$DATABASE_URL" \
//	  --rules-worker build/rules-worker/worker.mjs \
//	  --descriptor .scratch/onlinefixture/descriptor.json \
//	  --allow-origin http://127.0.0.1:5175
package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/serverapp"
)

const (
	keyID             = "onlinefixture-key-1"
	authorizedParty  = "https://online.fixture.local"
	loopbackHost     = "127.0.0.1"
	fixtureKeyPEMDir = "keys"
)

// account is one synthetic signed-in identity used by browser clients.
type account struct {
	ID    string `json:"id"`
	Token string `json:"token"`
}

// descriptor is the machine-readable handoff for the browser and the harness.
// It is written to a throwaway directory and never committed.
type descriptor struct {
	BaseURL        string   `json:"baseUrl"`
	Issuer         string   `json:"issuer"`
	JWKSURL        string   `json:"jwksUrl"`
	AllowedOrigins []string `json:"allowedOrigins"`
	Accounts       []account `json:"accounts"`
	Schema         string   `json:"schema"`
	Database       string   `json:"database"`
	RulesWorker    string   `json:"rulesWorker"`
	KeyPath        string   `json:"keyPath"`
	PID            int      `json:"pid"`
	StartedAt      string   `json:"startedAt"`
	ExpiresAt      string   `json:"expiresAt"`
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	var (
		databaseURL     = flag.String("database-url", "", "PostgreSQL URL of the local test database")
		rulesWorker     = flag.String("rules-worker", "", "Path to the private rules worker bundle")
		descriptorPath  = flag.String("descriptor", "", "File the descriptor is written to")
		apiPort         = flag.Int("api-port", 0, "Loopback port for the API (0 chooses a free port)")
		jwksPort        = flag.Int("jwks-port", 0, "Loopback port for the JWKS server (0 chooses a free port)")
		maxLifetime     = flag.Duration("max-lifetime", 30*time.Minute, "Hard upper bound on the fixture lifetime")
		allowRemote     = flag.Bool("allow-remote-database", false, "Permit a database host that is not loopback")
		keepSchema      = flag.Bool("keep-schema", false, "Keep the isolated schema after shutdown")
		friendEnabled   = flag.Bool("friend-enabled", true, "Set ONLINE_FRIEND_ENABLED for the fixture run")
		queueEnabled    = flag.Bool("queue-enabled", false, "Set ONLINE_QUEUE_ENABLED for the fixture run")
		serverEngine    = flag.String("server-engine", "", "Native UCI engine path; turns on the server engine seat, the remote MCP endpoint and the agent boards")
		allowedOrigins  stringList
	)
	flag.Var(&allowedOrigins, "allow-origin", "Origin allowed to call the fixture API (repeatable)")
	flag.Parse()

	if strings.TrimSpace(*databaseURL) == "" {
		*databaseURL = strings.TrimSpace(os.Getenv("ONLINE_FIXTURE_DATABASE_URL"))
	}
	if strings.TrimSpace(*databaseURL) == "" {
		return errors.New("--database-url is required")
	}
	if err := checkDatabaseHost(*databaseURL, *allowRemote); err != nil {
		return err
	}
	origins := allowedOrigins.values
	if len(origins) == 0 {
		origins = []string{"http://127.0.0.1:5175", "http://localhost:5175"}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	workDir, err := os.MkdirTemp("", "onlinefixture-")
	if err != nil {
		return errors.New("fixture work directory could not be created")
	}
	defer os.RemoveAll(workDir)

	// The durable restore fence is required by the server configuration. The
	// fixture owns one inside its throwaway work directory, so the composed
	// service observes a fence that no restore holds.
	fencePath := filepath.Join(workDir, "restore-fence")
	if err := os.MkdirAll(fencePath, 0o700); err != nil {
		return errors.New("fixture restore fence directory could not be created")
	}

	signingKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return errors.New("fixture signing key could not be generated")
	}
	_, certPool, keyPair, err := loopbackCertificate(signingKey)
	if err != nil {
		return err
	}

	jwksListener, err := net.Listen("tcp", net.JoinHostPort(loopbackHost, fmt.Sprint(*jwksPort)))
	if err != nil {
		return errors.New("fixture JWKS port could not be bound")
	}
	jwksPortValue := jwksListener.Addr().(*net.TCPAddr).Port
	issuer := fmt.Sprintf("https://%s:%d", loopbackHost, jwksPortValue)
	jwksURL := issuer + "/.well-known/jwks.json"

	jwksServer := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/.well-known/jwks.json" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(jwksDocument(signingKey))
		}),
		ReadHeaderTimeout: 5 * time.Second,
		// The certificate is carried by the server. ServeTLS is called
		// without file names, so the key has to be here.
		TLSConfig: tlsConfig(keyPair),
	}
	// A server that dies must never be reported as ready.
	jwksFailure := make(chan error, 1)
	go func() {
		if err := jwksServer.ServeTLS(jwksListener, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			jwksFailure <- err
		}
	}()
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = jwksServer.Shutdown(shutdown)
	}()

	schema, err := createSchema(ctx, *databaseURL)
	if err != nil {
		return err
	}
	if !*keepSchema {
		defer func() {
			cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			dropSchema(cleanup, *databaseURL, schema)
		}()
	}

	appPool, err := schemaPool(ctx, *databaseURL, schema)
	if err != nil {
		return err
	}
	defer appPool.Close()
	if err := migrations.Apply(ctx, appPool); err != nil {
		return errors.New("fixture migrations could not be applied to the isolated schema")
	}

	apiListener, err := net.Listen("tcp", net.JoinHostPort(loopbackHost, fmt.Sprint(*apiPort)))
	if err != nil {
		return errors.New("fixture API port could not be bound")
	}
	apiPortValue := apiListener.Addr().(*net.TCPAddr).Port

	trustedClient := &http.Client{
		Timeout:   5 * time.Second,
		Transport: &http.Transport{TLSClientConfig: tlsClientConfig(certPool)},
	}
	// The service configuration is read through the production loader, so the
	// fixture picks up every online setting the server understands, including
	// the feature switches, without repeating them here.
	environment := map[string]string{
		"DATABASE_URL":            scopedDatabaseURL(*databaseURL, schema),
		"CLERK_ISSUER":            issuer,
		"CLERK_JWKS_URL":          jwksURL,
		"CLERK_AUTHORIZED_PARTIES": authorizedParty,
		"APP_ALLOWED_ORIGINS":     strings.Join(origins, ","),
		"ONLINE_RULES_WORKER_ENTRY": strings.TrimSpace(*rulesWorker),
		"ONLINE_FRIEND_ENABLED":   strconv.FormatBool(*friendEnabled),
		"ONLINE_QUEUE_ENABLED":    strconv.FormatBool(*queueEnabled),
		"ONLINE_RESTORE_FENCE_PATH": fencePath,
	}
	if path := strings.TrimSpace(*serverEngine); path != "" {
		environment["ONLINE_SERVER_ENGINE_ENABLED"] = "true"
		environment["ONLINE_SERVER_ENGINE_PATH"] = path
		environment["ONLINE_MCP_ENABLED"] = "true"
		environment["ONLINE_AGENT_BOARDS_ENABLED"] = "true"
	}
	config, err := serverapp.Load(func(key string) string { return environment[key] })
	if err != nil {
		_ = apiListener.Close()
		return errors.New("fixture service configuration could not be loaded")
	}
	// The verifier must trust the fixture's own loopback certificate.
	config.Clerk.HTTPClient = trustedClient
	handler, release, err := serverapp.Open(ctx, config)
	if err != nil {
		_ = apiListener.Close()
		return errors.New("fixture service composition failed")
	}
	defer release()

	apiServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      40 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	go func() {
		if err := apiServer.Serve(apiListener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("fixture API stopped: %v", err)
		}
	}()

	accounts := []account{}
	for _, id := range []string{"fixture-owner-a", "fixture-owner-b", "fixture-owner-c"} {
		token, err := mintToken(signingKey, issuer, id, time.Now().Add(2*time.Hour))
		if err != nil {
			return err
		}
		accounts = append(accounts, account{ID: id, Token: token})
	}

	baseURL := fmt.Sprintf("http://%s:%d", loopbackHost, apiPortValue)

	// Readiness is proven, not assumed. Both servers must answer before the
	// fixture reports itself ready: the JWKS document over HTTPS, because the
	// API verifier needs it, and the API itself.
	if err := waitForJWKS(ctx, trustedClient, jwksURL, jwksFailure); err != nil {
		return err
	}
	if err := waitForAPI(ctx, baseURL); err != nil {
		return err
	}
	// The identity document must also work for the service itself. A fixture
	// whose verifier cannot check a signed session is not usable, so the
	// fixture proves an authenticated request before it reports itself ready.
	if err := probeAuthenticated(ctx, baseURL, accounts[0].Token); err != nil {
		return err
	}

	started := time.Now()
	result := descriptor{
		BaseURL:        baseURL,
		Issuer:         issuer,
		JWKSURL:        jwksURL,
		AllowedOrigins: origins,
		Accounts:       accounts,
		Schema:         schema,
		Database:       redactDatabase(*databaseURL),
		RulesWorker:    strings.TrimSpace(*rulesWorker),
		PID:            os.Getpid(),
		StartedAt:      started.UTC().Format(time.RFC3339),
		ExpiresAt:      started.Add(*maxLifetime).UTC().Format(time.RFC3339),
	}
	if err := writeDescriptor(*descriptorPath, workDir, signingKey, result); err != nil {
		return err
	}

	// The descriptor line is the readiness signal for the harness. It carries
	// no credential: the synthetic session tokens are written to the descriptor
	// file only.
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	fmt.Printf("ONLINE_FIXTURE_READY %s\n", encoded)
	os.Stdout.Sync()

	lifetime := time.NewTimer(*maxLifetime)
	defer lifetime.Stop()
	select {
	case <-ctx.Done():
	case <-lifetime.C:
	}

	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = apiServer.Shutdown(shutdown)
	return nil
}

// tlsConfig returns the server configuration that serves the fixture
// certificate.
func tlsConfig(keyPair tls.Certificate) *tls.Config {
	return &tls.Config{Certificates: []tls.Certificate{keyPair}, MinVersion: tls.VersionTLS12}
}

// tlsClientConfig returns the client configuration that trusts the fixture
// certificate.
func tlsClientConfig(pool *x509.CertPool) *tls.Config {
	return &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
}

// waitForJWKS proves that the identity document is really served. A fixture
// whose JWKS listener died must never report itself ready.
func waitForJWKS(ctx context.Context, client *http.Client, jwksURL string, failure <-chan error) error {
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-failure:
			return fmt.Errorf("fixture JWKS server failed: %w", err)
		default:
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, jwksURL, nil)
		if err != nil {
			return errors.New("fixture JWKS request could not be built")
		}
		response, err := client.Do(request)
		if err == nil {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK && strings.Contains(string(body), `"keys"`) {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("fixture JWKS server did not answer in time")
}

// waitForAPI proves that the composed service answers on loopback.
func waitForAPI(ctx context.Context, baseURL string) error {
	deadline := time.Now().Add(20 * time.Second)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return errors.New("fixture API did not answer in time")
		default:
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/online/features", nil)
		if err != nil {
			return errors.New("fixture API request could not be built")
		}
		response, err := client.Do(request)
		if err == nil {
			_ = response.Body.Close()
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("fixture API did not answer in time")
}

// probeAuthenticated proves that the service verifies a signed session. It
// fails when the identity document is not served, because the verifier cannot
// check the token then.
func probeAuthenticated(ctx context.Context, baseURL, token string) error {
	deadline := time.Now().Add(20 * time.Second)
	client := &http.Client{Timeout: 3 * time.Second}
	for time.Now().Before(deadline) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1/online/features", nil)
		if err != nil {
			return errors.New("fixture authenticated request could not be built")
		}
		request.Header.Set("Authorization", "Bearer "+token)
		response, err := client.Do(request)
		if err == nil {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<16))
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK && strings.Contains(string(body), "friends") && strings.Contains(string(body), "queue") {
				return nil
			}
			return errors.New("fixture API refused the authenticated probe, so the identity document is not served")
		}
		select {
		case <-ctx.Done():
			return errors.New("fixture authenticated probe did not finish")
		case <-time.After(200 * time.Millisecond):
		}
	}
	return errors.New("fixture API did not answer the authenticated probe in time")
}

// stringList collects a repeatable string flag.
type stringList struct {
	values []string
}

func (s *stringList) String() string { return strings.Join(s.values, ",") }

func (s *stringList) Set(value string) error {
	value = strings.TrimSpace(value)
	if value != "" {
		s.values = append(s.values, value)
	}
	return nil
}

// checkDatabaseHost refuses a database that is not on loopback. The fixture
// creates and drops a schema, so it must never touch a hosted database.
func checkDatabaseHost(databaseURL string, allowRemote bool) error {
	if allowRemote {
		return nil
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return errors.New("database URL could not be parsed")
	}
	host := parsed.Hostname()
	if host == "localhost" || host == loopbackHost || host == "::1" || host == "" {
		return nil
	}
	return errors.New("the fixture refuses a non-loopback database host")
}

// createSchema creates a uniquely named schema and returns its name.
func createSchema(ctx context.Context, databaseURL string) (string, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return "", errors.New("fixture could not connect to the database")
	}
	defer pool.Close()
	name := fmt.Sprintf("onlinefixture_%d_%s", os.Getpid(), randomSuffix())
	if _, err := pool.Exec(ctx, "CREATE SCHEMA "+name); err != nil {
		return "", errors.New("fixture could not create its isolated schema")
	}
	return name, nil
}

// schemaPool returns a pool whose search_path is the isolated schema.
func schemaPool(ctx context.Context, databaseURL, schema string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("fixture database URL could not be parsed")
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = map[string]string{}
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, errors.New("fixture could not open the isolated schema pool")
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("fixture could not reach the isolated schema")
	}
	return pool, nil
}

// dropSchema removes the isolated schema and everything in it.
func dropSchema(ctx context.Context, databaseURL, schema string) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		log.Printf("fixture could not connect to drop schema %s", schema)
		return
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
		log.Printf("fixture could not drop schema %s", schema)
	}
}

// loopbackCertificate returns a self-signed certificate for 127.0.0.1, the
// pool that trusts it and the TLS key pair that serves it.
func loopbackCertificate(key *rsa.PrivateKey) (*x509.Certificate, *x509.CertPool, tls.Certificate, error) {
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "online fixture loopback"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		IPAddresses:           []net.IP{net.ParseIP(loopbackHost), net.ParseIP("::1")},
		DNSNames:              []string{"localhost"},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, tls.Certificate{}, errors.New("fixture certificate could not be created")
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, tls.Certificate{}, errors.New("fixture certificate could not be parsed")
	}
	pool := x509.NewCertPool()
	pool.AddCert(certificate)
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	keyPair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, nil, tls.Certificate{}, errors.New("fixture TLS key pair could not be created")
	}
	return certificate, pool, keyPair, nil
}

// jwksDocument renders the public JWKS the API verifier fetches.
func jwksDocument(key *rsa.PrivateKey) map[string]any {
	return map[string]any{
		"keys": []map[string]any{{
			"kty": "RSA",
			"kid": keyID,
			"use": "sig",
			"alg": "RS256",
			"n":   base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.PublicKey.E)).Bytes()),
		}},
	}
}

// mintToken creates a signed session token for a synthetic account. The API
// verifies it exactly like a hosted session token; nothing is bypassed.
func mintToken(key *rsa.PrivateKey, issuer, subject string, expiry time.Time) (string, error) {
	header := map[string]any{"alg": "RS256", "kid": keyID, "typ": "JWT"}
	claims := map[string]any{
		"iss":       issuer,
		"sub":       subject,
		"sid":       "sess_" + subject,
		"azp":       authorizedParty,
		"iat":       time.Now().Unix(),
		"exp":       expiry.Unix(),
		"token_use": "session",
	}
	encode := func(value any) (string, error) {
		raw, err := json.Marshal(value)
		if err != nil {
			return "", err
		}
		return base64.RawURLEncoding.EncodeToString(raw), nil
	}
	encodedHeader, err := encode(header)
	if err != nil {
		return "", errors.New("fixture token header could not be encoded")
	}
	encodedClaims, err := encode(claims)
	if err != nil {
		return "", errors.New("fixture token claims could not be encoded")
	}
	signingInput := encodedHeader + "." + encodedClaims
	sum := sha256.Sum256([]byte(signingInput))
	digest, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", errors.New("fixture token could not be signed")
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(digest), nil
}

// writeDescriptor writes the descriptor, and the signing key, to a private
// directory so a browser harness can mint its own short-lived tokens.
func writeDescriptor(path, workDir string, signingKey *rsa.PrivateKey, result descriptor) error {
	keyPath := filepath.Join(workDir, fixtureKeyPEMDir, "signing-key.pem")
	if err := os.MkdirAll(filepath.Dir(keyPath), 0o700); err != nil {
		return errors.New("fixture key directory could not be created")
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(signingKey)})
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		return errors.New("fixture signing key could not be written")
	}
	result.KeyPath = keyPath
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return errors.New("fixture descriptor could not be encoded")
	}
	target := strings.TrimSpace(path)
	if target == "" {
		target = filepath.Join(workDir, "descriptor.json")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return errors.New("fixture descriptor directory could not be created")
	}
	if err := os.WriteFile(target, encoded, 0o600); err != nil {
		return errors.New("fixture descriptor could not be written")
	}
	return nil
}

// redactDatabase removes any password from a database URL for reporting.
func redactDatabase(databaseURL string) string {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return "redacted"
	}
	if parsed.User != nil {
		parsed.User = url.User("redacted")
	}
	return parsed.String()
}

// scopedDatabaseURL adds the isolated schema to a database URL.
func scopedDatabaseURL(databaseURL, schema string) string {
	separator := "?"
	if strings.Contains(databaseURL, "?") {
		separator = "&"
	}
	return databaseURL + separator + "search_path=" + schema
}

// randomSuffix returns a short random identifier.
func randomSuffix() string {
	buffer := make([]byte, 4)
	if _, err := rand.Read(buffer); err != nil {
		return "fixture"
	}
	return fmt.Sprintf("%x", buffer)
}
