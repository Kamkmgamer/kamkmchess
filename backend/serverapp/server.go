// Package serverapp composes the storage and online APIs for local and hosted entry points.
package serverapp

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/history"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/privacy"
	"github.com/Kamkmgamer/kamkmchess/backend/profile"
	"github.com/Kamkmgamer/kamkmchess/backend/queue"
	"github.com/Kamkmgamer/kamkmchess/backend/rulesworker"
	"github.com/Kamkmgamer/kamkmchess/backend/storage"
	"github.com/jackc/pgx/v5/pgxpool"
)

// guestProofIssuer issues guest ownership proofs through the trusted
// allocator.
//
// The allocator is the only component that may mint a proof, and it mints one
// only from a live guest seat credential. The HTTP surface never receives the
// allocator itself.
type guestProofIssuer struct {
	allocator *onlineauth.Allocator
}

func (i guestProofIssuer) IssueOwnershipProof(ctx context.Context, seatSecret, origin string) (onlineauth.IssuedOwnershipProof, error) {
	return i.allocator.IssueOwnershipProof(ctx, seatSecret, origin)
}

type Config struct {
	DatabaseURL string
	Clerk       auth.Config
	Online      OnlineConfig
}

// OnlineConfig holds the shared online authorization settings.
type OnlineConfig struct {
	// GuestCredentialTTL bounds the lifetime of an issued guest seat
	// credential.
	GuestCredentialTTL time.Duration
	// OwnershipProofTTL bounds the lifetime of an issued ownership proof.
	OwnershipProofTTL time.Duration
	// StreamMaxDuration bounds one live subscription window.
	StreamMaxDuration time.Duration
	// RulesWorkerEntry is the private rules process. Without it the online
	// service still answers reads but rejects commands that need the rules
	// policy.
	RulesWorkerEntry string
	// DeadlineSweepInterval is how often the server reconciles the match
	// deadlines that have passed.
	DeadlineSweepInterval time.Duration
	// DeadlineSweepBatch bounds one reconciliation pass.
	DeadlineSweepBatch int
	// HealthCheckInterval is how often the server refreshes the durable
	// service health.
	HealthCheckInterval time.Duration
	// FriendEnabled opens the friend invitation, link join and rematch
	// surface. It is off by default: a configured service origin is not an
	// enablement signal.
	FriendEnabled bool
	// QueueEnabled opens the public matchmaking surface. It is off by
	// default and independent of the friend surface.
	QueueEnabled bool
	// QueueSweepInterval is how often the server reconciles the queue
	// cutoffs, the readiness leases and the pending allocations.
	QueueSweepInterval time.Duration
	// QueueSweepBatch bounds one queue reconciliation pass.
	QueueSweepBatch int
	// HistoryPublishInterval is how often the server publishes the replay and
	// the profile results of the matches that completed.
	HistoryPublishInterval time.Duration
	// HistoryPublishBatch bounds one publishing pass.
	HistoryPublishBatch int
}

// flag reads an optional boolean setting. A missing or malformed value keeps
// the surface closed.
func flag(getenv func(string) string, key string) bool {
	return strings.TrimSpace(getenv(key)) == "1" || strings.EqualFold(strings.TrimSpace(getenv(key)), "true")
}

// Load reads only server configuration. Its errors never include configured values.
func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		DatabaseURL: strings.TrimSpace(getenv("DATABASE_URL")),
		Clerk: auth.Config{
			Issuer:            strings.TrimSpace(getenv("CLERK_ISSUER")),
			JWKSURL:           strings.TrimSpace(getenv("CLERK_JWKS_URL")),
			Audience:          strings.TrimSpace(getenv("CLERK_AUDIENCE")),
			AuthorizedParties: csv(getenv("CLERK_AUTHORIZED_PARTIES")),
			AllowedOrigins:    csv(getenv("APP_ALLOWED_ORIGINS")),
		},
		Online: OnlineConfig{
			GuestCredentialTTL:     duration(getenv, "ONLINE_GUEST_CREDENTIAL_TTL", onlineauth.DefaultGuestCredentialTTL),
			OwnershipProofTTL:      duration(getenv, "ONLINE_OWNERSHIP_PROOF_TTL", onlineauth.DefaultOwnershipProofTTL),
			StreamMaxDuration:      duration(getenv, "ONLINE_STREAM_MAX_DURATION", onlineauth.DefaultStreamMaxDuration),
			RulesWorkerEntry:       strings.TrimSpace(getenv("ONLINE_RULES_WORKER_ENTRY")),
			DeadlineSweepInterval:  duration(getenv, "ONLINE_DEADLINE_SWEEP_INTERVAL", DefaultDeadlineSweepInterval),
			DeadlineSweepBatch:     positiveInt(getenv, "ONLINE_DEADLINE_SWEEP_BATCH", DefaultDeadlineSweepBatch),
			HealthCheckInterval:    duration(getenv, "ONLINE_HEALTH_CHECK_INTERVAL", DefaultHealthCheckInterval),
			FriendEnabled:          flag(getenv, "ONLINE_FRIEND_ENABLED"),
			QueueEnabled:           flag(getenv, "ONLINE_QUEUE_ENABLED"),
			QueueSweepInterval:     duration(getenv, "ONLINE_QUEUE_SWEEP_INTERVAL", DefaultQueueSweepInterval),
			QueueSweepBatch:        positiveInt(getenv, "ONLINE_QUEUE_SWEEP_BATCH", DefaultQueueSweepBatch),
			HistoryPublishInterval: duration(getenv, "ONLINE_HISTORY_PUBLISH_INTERVAL", history.DefaultPublishInterval),
			HistoryPublishBatch:    positiveInt(getenv, "ONLINE_HISTORY_PUBLISH_BATCH", history.DefaultPublishBatch),
		},
	}
	if cfg.DatabaseURL == "" || len(cfg.Clerk.AllowedOrigins) == 0 {
		return Config{}, errors.New("storage configuration incomplete")
	}
	if _, err := auth.NewVerifier(cfg.Clerk); err != nil {
		return Config{}, errors.New("invalid Clerk verifier configuration")
	}
	return cfg, nil
}

// Open never migrates the database. Use cmd/migrate with a separate role first.
//
// It returns the composed API handler. The private single-owner sync API keeps
// its own origin and header policy; the online participant API is mounted
// under its own path with the guest seat credential header allowed.
func Open(ctx context.Context, cfg Config) (http.Handler, func(), error) {
	verifier, err := auth.NewVerifier(cfg.Clerk)
	if err != nil {
		return nil, nil, errors.New("invalid Clerk verifier configuration")
	}
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, nil, errors.New("database initialization failed")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, nil, errors.New("database is unavailable")
	}
	store, err := storage.Open(ctx, pool)
	if err != nil {
		pool.Close()
		return nil, nil, errors.New("storage initialization failed")
	}
	evaluator, closeWorker, err := openEvaluator(cfg.Online.RulesWorkerEntry)
	if err != nil {
		pool.Close()
		return nil, nil, err
	}
	// The durable health boundary. A service without a rules process cannot
	// evaluate online play, so it reports itself unavailable and never
	// offers an abandonment claim.
	health := online.NewHealthReporter(pool)
	if evaluator == nil {
		if err = health.ReportDependency(ctx, online.DependencyRules, online.HealthUnavailable, "no rules worker is configured"); err != nil {
			if closeWorker != nil {
				closeWorker()
			}
			pool.Close()
			return nil, nil, errors.New("online health initialization failed")
		}
	} else if err = health.ReportDependency(ctx, online.DependencyRules, online.HealthHealthy, "the rules process is configured"); err != nil {
		if closeWorker != nil {
			closeWorker()
		}
		pool.Close()
		return nil, nil, errors.New("online health initialization failed")
	}
	if err = health.ReportDependency(ctx, online.DependencyDatabase, online.HealthHealthy, "the shared state is reachable"); err != nil {
		if closeWorker != nil {
			closeWorker()
		}
		pool.Close()
		return nil, nil, errors.New("online health initialization failed")
	}
	authorizer, err := onlineauth.Open(ctx, pool, verifier, onlineauth.Options{
		GuestCredentialTTL: cfg.Online.GuestCredentialTTL,
		OwnershipProofTTL:  cfg.Online.OwnershipProofTTL,
		StreamMaxDuration:  cfg.Online.StreamMaxDuration,
	})
	if err != nil {
		if closeWorker != nil {
			closeWorker()
		}
		pool.Close()
		return nil, nil, errors.New("online authorization initialization failed")
	}
	// The authorization service is the participant authorizer. The writer
	// re-checks it inside every acceptance transaction.
	onlineService, err := online.Open(ctx, pool, evaluator,
		online.WithSeatAuthorizer(authorizer),
		online.WithHealthReporter(health),
		online.WithRecoveryGate(),
	)
	if err != nil {
		if closeWorker != nil {
			closeWorker()
		}
		pool.Close()
		return nil, nil, errors.New("online service initialization failed")
	}
	// The canonical recovery runs before the service accepts traffic. The
	// adjusted deadlines of the unfinished matches are published first, and
	// the mutation path stays closed until the recovery completed.
	if _, err = onlineService.RecoverFromInterruption(ctx); err != nil {
		slog.Default().Error("online recovery failed; mutations stay closed", "error", err)
	}
	// The public profile service owns the stable public identity of an
	// account and the explicit guest link. It writes only its own tables.
	profileService, err := profile.Open(ctx, pool, authorizer, profile.Options{})
	if err != nil {
		if closeWorker != nil {
			closeWorker()
		}
		pool.Close()
		return nil, nil, errors.New("public profile initialization failed")
	}
	// The history service publishes the allowlisted public replay and the
	// public game history of the completed online matches. It writes only its
	// own tables, and it never writes match state.
	historyService, err := history.Open(ctx, pool, profileService, history.Options{})
	if err != nil {
		pool.Close()
		return nil, nil, errors.New("public history initialization failed")
	}
	root := http.NewServeMux()
	// The online surface carries the participant routes, the feature state
	// and, when the friend switch is on, the friend routes. The feature
	// state is always mounted: the browser asks it before it shows
	// anything, and a configured service origin is not an enablement
	// signal.
	surface := http.NewServeMux()
	surface.Handle("/v1/online/features", httpapi.NewFeatures(httpapi.OnlineFeatures{
		Friends: cfg.Online.FriendEnabled,
		Queue:   cfg.Online.QueueEnabled,
	}))
	surface.Handle("/", httpapi.NewOnlineWithPublicReplay(onlineService, authorizer, httpapi.OnlineOptions{AllowedOrigins: cfg.Clerk.AllowedOrigins}, historyService))
	if cfg.Online.FriendEnabled {
		// The friend surface is independent of the participant commands. It
		// is mounted only when the switch is on, so a closed surface is not
		// reachable at all.
		friendService, err := invite.Open(ctx, pool, onlineService, onlineService, onlineauth.NewAllocator(authorizer), invite.Options{
			GuestCredentialTTL: cfg.Online.GuestCredentialTTL,
			InvitationTTL:      invite.InvitationTTL,
		})
		if err != nil {
			if closeWorker != nil {
				closeWorker()
			}
			pool.Close()
			return nil, nil, errors.New("friend invitation initialization failed")
		}
		friendHandler := httpapi.NewFriends(friendService, onlineService, authorizer, httpapi.FriendsOptions{
			AllowedOrigins: cfg.Clerk.AllowedOrigins,
			LabelResolver:  invite.NewAccountLabelResolver(pool),
		})
		surface.Handle("/v1/online/invitations", friendHandler)
		surface.Handle("/v1/online/invitations/", friendHandler)
		surface.Handle("/v1/online/rematches", friendHandler)
		surface.Handle("/v1/online/rematches/", friendHandler)
		surface.Handle("GET /v1/online/matches/{matchID}/rematch", friendHandler)
	}
	root.Handle("/v1/online/", httpapi.CORSWithHeaders(cfg.Clerk.AllowedOrigins, httpapi.OnlineRequestHeaders, surface))
	// The public queue is mounted only when its switch is on. A closed
	// surface is not mounted at all, so its routes answer 404.
	var queueService *queue.Service
	if cfg.Online.QueueEnabled {
		// The queue allocates matches through the shared writer. The writer
		// owns the trusted allocation seam, so the queue never writes a
		// match row itself.
		allocator, ok := any(onlineService).(queue.MatchAllocator)
		if !ok {
			pool.Close()
			return nil, nil, errors.New("the public queue needs the shared match allocator")
		}
		queueService, err = queue.Open(ctx, pool, queue.Options{
			Allocator:   allocator,
			Labels:      invite.NewAccountLabelResolver(pool),
			Credentials: onlineauth.NewAllocator(authorizer),
		})
		if err != nil {
			pool.Close()
			return nil, nil, errors.New("public queue initialization failed")
		}
		root.Handle("/v1/online/queue/", httpapi.CORSWithHeaders(cfg.Clerk.AllowedOrigins, httpapi.OnlineRequestHeaders,
			httpapi.NewQueue(queueService, authorizer, httpapi.OnlineOptions{AllowedOrigins: cfg.Clerk.AllowedOrigins})))
	}
	// The public history API is mounted under its own prefix. Its reads need
	// no credential at all.
	root.Handle("/v1/public/", httpapi.CORS(cfg.Clerk.AllowedOrigins, httpapi.NewPublicHistory(historyService)))
	// The privacy API is mounted under its own prefix. It carries the account
	// and the guest credential header, and the private single-owner sync API
	// is never widened to accept them.
	privacyService, err := privacy.Open(ctx, pool, authorizer, privacy.Options{})
	if err != nil {
		pool.Close()
		return nil, nil, errors.New("privacy service initialization failed")
	}
	root.Handle("/v1/privacy/", httpapi.CORSWithMethods(cfg.Clerk.AllowedOrigins, httpapi.PrivacyRequestHeaders, "GET, POST, OPTIONS", httpapi.NewPrivacy(privacyService, historyService, authorizer, httpapi.OnlineOptions{AllowedOrigins: cfg.Clerk.AllowedOrigins})))
	// The public profile API is mounted under its own prefixes so it never
	// widens the private single-owner sync API.
	profileHandler := httpapi.CORSWithMethods(cfg.Clerk.AllowedOrigins, httpapi.ProfileRequestHeaders, "GET, POST, PUT, OPTIONS", httpapi.NewProfile(profileService, guestProofIssuer{allocator: onlineauth.NewAllocator(authorizer)}, authorizer, httpapi.OnlineOptions{AllowedOrigins: cfg.Clerk.AllowedOrigins}))
	root.Handle("/v1/profiles/", profileHandler)
	root.Handle("/v1/account/", profileHandler)
	root.Handle("/v1/guest-seats/", profileHandler)
	root.Handle("/", httpapi.CORS(cfg.Clerk.AllowedOrigins, httpapi.NewAuthenticated(store, verifier)))
	// The trusted deadline reconciliation loop settles the matches whose
	// opening reply window or main clock has passed, without waiting for a
	// participant command. It is bound to the server context and to the
	// release function.
	stopDeadlines := StartDeadlineReconciler(ctx, onlineService, DeadlineSweepConfig{
		Interval: cfg.Online.DeadlineSweepInterval,
		Batch:    cfg.Online.DeadlineSweepBatch,
	})
	// The health monitor keeps the durable health in step with the
	// dependencies, so a service outage never looks like an absent
	// opponent.
	stopHealth := StartHealthMonitor(ctx, pool, health, onlineService, HealthMonitorConfig{Interval: cfg.Online.HealthCheckInterval})
	// The queue reconciliation loop expires the unresponsive entries,
	// resolves the cutoffs that passed and finishes the pending
	// allocations. It only runs when the queue is open.
	stopQueue := func() {}
	if queueService != nil {
		stopQueue = StartQueueReconciler(ctx, queueService, QueueSweepConfig{
			Interval: cfg.Online.QueueSweepInterval,
			Batch:    cfg.Online.QueueSweepBatch,
		})
	}
	// The publishing loop publishes the replay and the profile results of the
	// matches that completed. It is bound to the server context and to the
	// release function.
	stopPublishing := history.StartPublisher(ctx, historyService, history.PublishConfig{
		Interval: cfg.Online.HistoryPublishInterval,
		Batch:    cfg.Online.HistoryPublishBatch,
	})
	release := func() {
		// The loops stop before the pool closes, so no background sweep can
		// use a closed connection.
		stopDeadlines()
		stopHealth()
		stopQueue()
		stopPublishing()
		if closeWorker != nil {
			closeWorker()
		}
		pool.Close()
	}
	return root, release, nil
}

// openEvaluator starts the private rules process when one is configured.
func openEvaluator(entry string) (online.Evaluator, func(), error) {
	if entry == "" {
		return nil, nil, nil
	}
	client, err := rulesworker.New(rulesworker.Config{Entry: entry})
	if err != nil {
		return nil, nil, errors.New("online rules worker initialization failed")
	}
	evaluator, err := rulesworker.NewOnlineEvaluator(client)
	if err != nil {
		_ = client.Close()
		return nil, nil, errors.New("online rules worker initialization failed")
	}
	return evaluator, func() { _ = client.Close() }, nil
}

func csv(value string) []string {
	var result []string
	seen := map[string]bool{}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part != "" && !seen[part] {
			seen[part] = true
			result = append(result, part)
		}
	}
	return result
}

// duration reads an optional duration setting. An unparsable or non-positive
// value falls back to the default instead of failing the whole boot.
func duration(getenv func(string) string, key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(getenv(key))
	if raw == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
