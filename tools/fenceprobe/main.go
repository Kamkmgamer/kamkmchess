//go:build fenceprobe

// Command fenceprobe exercises the durable restore fence of the privacy
// service from the outside.
//
// It uses the real fence code of the privacy service, so the proof in
// deploy/verify-fence-access.mjs does not restate the file semantics: it
// writes, observes and clears the fence exactly the way the restore and the
// API do.
//
// The build tag keeps it out of every production binary.
//
// Usage:
//
//	fenceprobe open  <path> <restore-id> <ledger-digest-hex>
//	fenceprobe state  <path>
//	fenceprobe close <path> <restore-id> <ledger-digest-hex>
//
// The state command exits with 0 when the fence is closed and with 3 when it
// is open, so a caller can act on the state without parsing the output.

package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Kamkmgamer/kamkmchess/backend/backup"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/migrations"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 3 {
		return errors.New("usage: fenceprobe write|state|clear <path> [restore-id] [digest-hex]")
	}
	command := os.Args[1]
	path := os.Args[2]

	// The fence never touches the database. The pool is created lazily and is
	// only there because the service requires one.
	pool, err := pgxpool.New(context.Background(), "postgres://127.0.0.1:1/unused")
	if err != nil {
		return errors.New("fence probe could not prepare the service")
	}
	defer pool.Close()
	service, err := privacy.Open(context.Background(), pool, nil, privacy.Options{FencePath: path})
	if err != nil {
		return errors.New("fence probe could not open the privacy service")
	}

	switch command {
	case "cert":
		// The throwaway service needs a certificate for its TLS settings.
		// The image has no openssl, so the helper writes one.
		if len(os.Args) < 3 {
			return errors.New("cert needs a directory")
		}
		return writeCertificate(os.Args[2])
	case "fence-only":
		// The bounded lifecycle command: it admits the fence and gives it
		// back, so the proof can show who may write the fence without
		// holding a service.
		if len(os.Args) < 4 {
			return errors.New("fence-only needs a restore id")
		}
		return fenceOnly(context.Background(), os.Args[2], os.Args[3])
	case "watch":
		// The helper serves the gate without taking the fence, so the proof
		// can show the service serving again after the fence was closed.
		if len(os.Args) < 5 {
			return errors.New("watch needs a database url and a port")
		}
		return watch(os.Args[3], os.Args[4], os.Args[2])
	case "serve":
		// The helper serves the production serving gate over HTTP, so the
		// proof can show the real refusal and the real resume. When a restore
		// identifier is given, it begins the fence and holds it, so the
		// service refuses while the helper lives.
		if len(os.Args) < 6 {
			return errors.New("serve needs a database url, a port and a restore id")
		}
		// The arguments are: serve <fence parent> <database url> <port> <restore id>.
		return serve(os.Args[3], os.Args[4], os.Args[2], os.Args[5])
	case "state":
		// The state is read from the marker of the fence, not from a file the
		// helper wrote itself.
		open, err := service.FenceOpen()
		if err != nil {
			// An unreadable fence is an open fence, and the error says why.
			fmt.Println("unreadable")
			return err
		}
		if open {
			fmt.Println("open")
			os.Exit(3)
		}
		fmt.Println("closed")
		return nil
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

// serve mounts the production serving gate in front of a health handler.
//
// The gate is the real one: while the restore fence is open, every request is
// refused with the retryable answer, and after the fence is closed the
// service serves again.
// fenceOnly admits the fence and gives it back, so the proof can show the
// permission boundary of the fence without a running service.
func fenceOnly(ctx context.Context, fencePath, restoreID string) error {
	pool, err := pgxpool.New(ctx, "postgres://127.0.0.1:1/unused")
	if err != nil {
		return errors.New("fence probe could not prepare the pool")
	}
	defer pool.Close()
	service, err := privacy.Open(ctx, pool, nil, privacy.Options{FencePath: fencePath})
	if err != nil {
		return errors.New("fence probe could not open the privacy service for the fence")
	}
	handle, err := service.BeginFence(restoreID, false)
	if err != nil {
		return err
	}
	handle.Release()
	fmt.Println("opened")
	return nil
}

// watch serves the production serving gate without taking the fence.
func watch(databaseURL, port, fencePath string) error {
	return serveGate(databaseURL, port, fencePath, "")
}

func serve(databaseURL, port, fencePath, restoreID string) error {
	return serveGate(databaseURL, port, fencePath, restoreID)
}

// serveGate serves the production serving gate. It takes the fence when a
// restore identifier is given.
func serveGate(databaseURL, port, fencePath, restoreID string) error {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("fence probe could not prepare the database pool: %w", err)
	}
	defer pool.Close()
	// The schema carries the identifier of the run, so the proof can drop
	// exactly its own schema and nothing else.
	suffix := strings.TrimSpace(os.Getenv("KAMKM_PROBE_RUN"))
	if suffix == "" {
		generated, err := randomSuffix()
		if err != nil {
			return err
		}
		suffix = generated
	}
	if !probeRunPattern.MatchString(suffix) {
		return errors.New("fence probe could not use the run identifier of its schema")
	}
	schema := "fence_probe_" + suffix
	// The fence is admitted first, with an instance that has no schema and
	// no migrations, so a refusal is a refusal of the fence and never of a
	// connection or of a table.
	fenceService, err := privacy.Open(ctx, pool, nil, privacy.Options{FencePath: fencePath})
	if err != nil {
		return errors.New("fence probe could not open the privacy service for the fence")
	}
	var handle *privacy.FenceHandle
	if restoreID != "" {
		handle, err = fenceService.BeginFence(restoreID, false)
		if err != nil {
			return err
		}
		defer handle.Release()
	}
	// The proof drops the schema, so a failure to name it has to be an
	// error and not a silent loss. The caller chooses where the name is
	// written, because the parent of the fence belongs to the database
	// container.
	nameFile := strings.TrimSpace(os.Getenv("KAMKM_PROBE_SCHEMA_FILE"))
	if nameFile == "" {
		nameFile = filepath.Join(filepath.Dir(fencePath), "schema-name")
	}
	if err = os.WriteFile(nameFile, []byte(schema), 0o644); err != nil {
		return errors.New("fence probe could not name its schema")
	}
	// The schema belongs to the run, and several helpers of one run may use
	// it: the holder of the fence and the watcher that starts after the
	// take-over share it, and the migrations are idempotent. The proof drops
	// the schema of the run and nothing else.
	if _, err = pool.Exec(ctx, "CREATE SCHEMA IF NOT EXISTS "+schema); err != nil {
		return errors.New("fence probe could not create its schema")
	}
	defer func() {
		// The schema is dropped when the helper stops. A failure is reported,
		// because a leftover schema would hold a restore gate of its own.
		if _, dropErr := pool.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); dropErr != nil {
			fmt.Fprintln(os.Stderr, "fence probe could not drop its schema:", dropErr)
		}
	}()

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return errors.New("fence probe could not parse the database url")
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = map[string]string{}
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	scoped, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return errors.New("fence probe could not open the scoped pool")
	}
	defer scoped.Close()
	if err = migrations.Apply(ctx, scoped); err != nil {
		return errors.New("fence probe could not apply the migrations")
	}

	service, err := privacy.Open(ctx, scoped, nil, privacy.Options{FencePath: fencePath})
	if err != nil {
		return errors.New("fence probe could not open the privacy service")
	}
	// The removal ledger the restore has to apply is bound to the
	// lifecycle, after the database was read. The evidence of it is written
	// next to the marker of the lifecycle, and the marker names its digest.
	//
	// The helper adds one synthetic subject removal to the ledger it binds:
	// the ledger of a throwaway database is empty, and a close that carries
	// a ledger which does not contain the required one can only be refused
	// when the required ledger holds a record.
	var bound backup.AppliedRemovalLedger
	if handle != nil {
		applied, err := service.AppliedRemovalLedger(ctx)
		if err != nil {
			return err
		}
		bound = applied
		bound.Subjects = append(bound.Subjects, backup.SubjectRemovalRecord{
			RecordID:    "rs_probe_" + restoreID,
			SubjectKind: "account",
			SubjectRef:  "probe-" + restoreID,
			Scope:       "explicit_removal",
			RemovedAt:   time.Now().UTC(),
		})
		if err = handle.Bind(bound); err != nil {
			return err
		}
	}
	// The close of the lifecycle is outside the gate, because the gate
	// refuses every request while the fence is open.
	gated := httpapi.WithServingGate(service, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("serving"))
	}))
	mux := http.NewServeMux()
	// The close of the lifecycle is outside the gate, because the gate
	// refuses every request while the fence is open.
	mux.HandleFunc("/finish", func(w http.ResponseWriter, r *http.Request) {
		// A removal ledger that does not contain the one the restore had to
		// apply has to be refused, so the proof can show that the fence is not
		// closed by accident.
		applied := bound
		if r.URL.Query().Get("wrong") == "1" {
			applied = backup.AppliedRemovalLedger{}
		}
		if handle == nil {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte("privacy: this helper holds no fence"))
			return
		}
		if err := handle.Finish(applied); err != nil {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(err.Error()))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("closed"))
	})
	mux.Handle("/healthz", gated)
	mux.Handle("/", gated)
	handler := mux
	server := &http.Server{
		// The listener binds every interface of the throwaway container, so the
		// published port reaches it. The container itself is isolated and the
		// publication is on the loopback of the host.
		Addr:              "0.0.0.0:" + port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	fmt.Println("serving")
	return server.ListenAndServe()
}

// probeRunPattern is the shape of the run identifier of a probe.
var probeRunPattern = regexp.MustCompile("^[a-z0-9]{8,32}$")

// randomSuffix returns a short random identifier.
//
// The randomness is not optional: a name that repeats would let two runs
// share a schema, so a failure is an error and never a fixed name.
func randomSuffix() (string, error) {
	buffer := make([]byte, 8)
	if _, err := rand.Read(buffer); err != nil {
		return "", errors.New("fence probe could not read random bytes for its schema name")
	}
	return fmt.Sprintf("%x", buffer), nil
}

// writeCertificate writes a self-signed certificate and its key for the
// loopback service of the proof.
func writeCertificate(directory string) error {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return errors.New("fence probe could not generate the certificate key")
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:              []string{"localhost"},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return errors.New("fence probe could not create the certificate")
	}
	if err = os.MkdirAll(directory, 0o755); err != nil {
		return errors.New("fence probe could not create the certificate directory")
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if err = os.WriteFile(filepath.Join(directory, "server.crt"), certPEM, 0o644); err != nil {
		return errors.New("fence probe could not write the certificate")
	}
	// PostgreSQL refuses a key that the database user can read only through
	// the world or the group of another user. The key belongs to root and is
	// readable by the database group, which is what the server accepts.
	keyPath := filepath.Join(directory, "server.key")
	if err = os.WriteFile(keyPath, keyPEM, 0o640); err != nil {
		return errors.New("fence probe could not write the certificate key")
	}
	if err = os.Chown(keyPath, 0, 70); err != nil {
		return errors.New("fence probe could not hand the certificate key to the database group")
	}
	fmt.Println("written")
	return nil
}
