// Package serverapp composes the storage and online APIs for local and hosted entry points.
package serverapp

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/agentboards"
	"github.com/Kamkmgamer/kamkmchess/backend/auth"
	"github.com/Kamkmgamer/kamkmchess/backend/cohort"
	"github.com/Kamkmgamer/kamkmchess/backend/history"
	"github.com/Kamkmgamer/kamkmchess/backend/httpapi"
	"github.com/Kamkmgamer/kamkmchess/backend/invite"
	"github.com/Kamkmgamer/kamkmchess/backend/mcpserver"
	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineauth"
	"github.com/Kamkmgamer/kamkmchess/backend/onlineswitch"
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
	// FriendCohort narrows the accounts that may use the friend surface.
	//
	// It is an allowlist of account identifiers and it is empty by default,
	// which admits every signed-in account. It never excludes a guest: a
	// guest has to be able to create a friend link and to accept an
	// invitation that was issued while friend play was enabled.
	FriendCohort cohort.Cohort
	// OwnerAccounts are the account identifiers that may open and close the
	// friend and queue surfaces from the site. FriendEnabled and
	// QueueEnabled stay the defaults until an owner changes them. Empty
	// means no one can, and the surfaces follow the configuration only.
	OwnerAccounts []string
	// QueueCohort narrows the accounts that may use the public queue.
	//
	// It is an allowlist of account identifiers and it is empty by default,
	// which admits every signed-in account.
	QueueCohort cohort.Cohort
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
	// RestoreFencePath is the path of the durable restore fence.
	//
	// The fence lives outside the restored database, so it survives the
	// schema replacement of a restore and a crash of the restore process. The
	// service and the restore tool have to use the same path, and the path
	// has to be a shared persistent location: a per container or per host
	// path would let two instances disagree about the state of a restore.
	//
	// It is required. A configuration without it is refused, because a
	// service that never observes the fence serves a restored copy whose
	// removal ledger was never replayed.
	RestoreFencePath string
	// ServerEngineEnabled lets the server play its own native Stockfish seat.
	// It is off by default. The seat only plays in matches that were created
	// against it, so the switch opens no surface by itself.
	ServerEngineEnabled bool
	// ServerEnginePath is the native UCI engine executable. It is required
	// when the server engine is enabled.
	ServerEnginePath string
	// ServerEngineSlots bounds the concurrent searches.
	ServerEngineSlots int
	// ServerEngineSweepInterval is how often the server looks for engine
	// seats that are to move.
	ServerEngineSweepInterval time.Duration
	// MCPEnabled mounts the anonymous remote MCP endpoint at /v1/mcp, where
	// an agent plays the server engine. It is off by default and needs the
	// server engine.
	MCPEnabled bool
	// MCPMaxActiveGames bounds the unfinished agent games.
	MCPMaxActiveGames int
	// MCPStartsPerHour bounds the games one client address may start.
	MCPStartsPerHour int
	// MCPTrustProxy reads the client address from the last X-Forwarded-For
	// entry. Set it only behind exactly one proxy that appends to the header.
	MCPTrustProxy bool
	// AgentBoardsEnabled mounts the public community and verified agent
	// boards at /v1/public/agent-boards. It is off by default and needs the
	// remote MCP endpoint, which records the games.
	AgentBoardsEnabled bool
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
			GuestCredentialTTL:        duration(getenv, "ONLINE_GUEST_CREDENTIAL_TTL", onlineauth.DefaultGuestCredentialTTL),
			OwnershipProofTTL:         duration(getenv, "ONLINE_OWNERSHIP_PROOF_TTL", onlineauth.DefaultOwnershipProofTTL),
			StreamMaxDuration:         duration(getenv, "ONLINE_STREAM_MAX_DURATION", onlineauth.DefaultStreamMaxDuration),
			RulesWorkerEntry:          strings.TrimSpace(getenv("ONLINE_RULES_WORKER_ENTRY")),
			DeadlineSweepInterval:     duration(getenv, "ONLINE_DEADLINE_SWEEP_INTERVAL", DefaultDeadlineSweepInterval),
			DeadlineSweepBatch:        positiveInt(getenv, "ONLINE_DEADLINE_SWEEP_BATCH", DefaultDeadlineSweepBatch),
			HealthCheckInterval:       duration(getenv, "ONLINE_HEALTH_CHECK_INTERVAL", DefaultHealthCheckInterval),
			FriendEnabled:             flag(getenv, "ONLINE_FRIEND_ENABLED"),
			QueueEnabled:              flag(getenv, "ONLINE_QUEUE_ENABLED"),
			FriendCohort:              cohort.Parse(getenv("ONLINE_FRIEND_COHORT")),
			QueueCohort:               cohort.Parse(getenv("ONLINE_QUEUE_COHORT")),
			OwnerAccounts:             cohort.Parse(getenv("ONLINE_OWNER_ACCOUNTS")).Accounts(),
			QueueSweepInterval:        duration(getenv, "ONLINE_QUEUE_SWEEP_INTERVAL", DefaultQueueSweepInterval),
			QueueSweepBatch:           positiveInt(getenv, "ONLINE_QUEUE_SWEEP_BATCH", DefaultQueueSweepBatch),
			HistoryPublishInterval:    duration(getenv, "ONLINE_HISTORY_PUBLISH_INTERVAL", history.DefaultPublishInterval),
			HistoryPublishBatch:       positiveInt(getenv, "ONLINE_HISTORY_PUBLISH_BATCH", history.DefaultPublishBatch),
			RestoreFencePath:          strings.TrimSpace(getenv("ONLINE_RESTORE_FENCE_PATH")),
			ServerEngineEnabled:       flag(getenv, "ONLINE_SERVER_ENGINE_ENABLED"),
			ServerEnginePath:          strings.TrimSpace(getenv("ONLINE_SERVER_ENGINE_PATH")),
			ServerEngineSlots:         positiveInt(getenv, "ONLINE_SERVER_ENGINE_SLOTS", DefaultServerEngineSlots),
			ServerEngineSweepInterval: duration(getenv, "ONLINE_SERVER_ENGINE_SWEEP_INTERVAL", DefaultServerEngineSweepInterval),
			MCPEnabled:                flag(getenv, "ONLINE_MCP_ENABLED"),
			MCPMaxActiveGames:         positiveInt(getenv, "ONLINE_MCP_MAX_ACTIVE_GAMES", DefaultMCPMaxActiveGames),
			MCPStartsPerHour:          positiveInt(getenv, "ONLINE_MCP_STARTS_PER_HOUR", DefaultMCPStartsPerHour),
			MCPTrustProxy:             flag(getenv, "ONLINE_MCP_TRUST_PROXY"),
			AgentBoardsEnabled:        flag(getenv, "ONLINE_AGENT_BOARDS_ENABLED"),
		},
	}
	if cfg.DatabaseURL == "" || len(cfg.Clerk.AllowedOrigins) == 0 {
		return Config{}, errors.New("storage configuration incomplete")
	}
	// The durable restore fence is not an optional setting. A service without
	// it never observes an open fence, so it would serve a restored database
	// whose removal ledger was never replayed. The absence of the setting
	// fails closed: the boot stops instead of serving without the fence.
	//
	// The error names the setting and never its value: the path is operator
	// material and it does not belong in a log line or in a report.
	if cfg.Online.RestoreFencePath == "" {
		return Config{}, errors.New("the durable restore fence path is not configured")
	}
	if cfg.Online.ServerEngineEnabled && cfg.Online.ServerEnginePath == "" {
		return Config{}, errors.New("the server engine is enabled without an engine path")
	}
	if cfg.Online.MCPEnabled && !cfg.Online.ServerEngineEnabled {
		return Config{}, errors.New("the remote MCP endpoint needs the server engine")
	}
	if cfg.Online.AgentBoardsEnabled && !cfg.Online.MCPEnabled {
		return Config{}, errors.New("the agent boards need the remote MCP endpoint")
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
	// The composition fails closed without the durable restore fence.
	//
	// The configuration loader already refuses a missing setting, and the
	// check here keeps the guarantee for a configuration that was assembled
	// by hand: a service that never observes the fence would serve a
	// restored database whose removal ledger was not replayed.
	if strings.TrimSpace(cfg.Online.RestoreFencePath) == "" {
		return nil, nil, errors.New("the durable restore fence path is not configured")
	}
	verifier, err := auth.NewVerifier(cfg.Clerk)
	if err != nil {
		return nil, nil, errors.New("invalid Clerk verifier configuration")
	}
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, nil, errors.New("database initialization failed")
	}
	// The owned resources are released on every exit, so a failed start
	// never leaves a rules worker process behind.
	owned := &closerSet{}
	closeAll := owned.release
	// Every exit that does not hand the composition over releases the owned
	// resources and closes the pool. The guard is disarmed when the
	// composition is handed over, so the release function owns everything
	// from then on.
	//
	// The guard exists because a boot has many exits, and an exit that
	// forgets the cleanup leaks the rules worker of a service that never
	// served a request. No exit may skip it, and the history and the queue
	// exits are no exception: their services fail closed on a broken
	// dependency, and the worker of the failed boot still has to go.
	booted := false
	defer func() {
		if booted {
			return
		}
		closeAll()
		pool.Close()
	}()
	if err = pool.Ping(ctx); err != nil {
		return nil, nil, errors.New("database is unavailable")
	}
	evaluator, closeWorker, err := openEvaluator(ctx, cfg.Online.RulesWorkerEntry)
	if closeWorker != nil {
		// The closer is owned even when the start failed, so the guard
		// releases the worker of a failed boot.
		owned.own(closeWorker)
	}
	if err != nil {
		return nil, nil, err
	}
	// The durable health boundary. A service without a rules process cannot
	// evaluate online play, so it reports itself unavailable and never
	// offers an abandonment claim.
	health := online.NewHealthReporter(pool)
	if evaluator == nil {
		if err = health.ReportDependency(ctx, online.DependencyRules, online.HealthUnavailable, "no rules worker is configured"); err != nil {
			return nil, nil, errors.New("online health initialization failed")
		}
	} else if err = health.ReportDependency(ctx, online.DependencyRules, online.HealthHealthy, "the rules process answered at boot"); err != nil {
		return nil, nil, errors.New("online health initialization failed")
	}
	if err = health.ReportDependency(ctx, online.DependencyDatabase, online.HealthHealthy, "the shared state is reachable"); err != nil {
		return nil, nil, errors.New("online health initialization failed")
	}
	authorizer, err := onlineauth.Open(ctx, pool, verifier, onlineauth.Options{
		GuestCredentialTTL: cfg.Online.GuestCredentialTTL,
		OwnershipProofTTL:  cfg.Online.OwnershipProofTTL,
		StreamMaxDuration:  cfg.Online.StreamMaxDuration,
	})
	if err != nil {
		return nil, nil, errors.New("online authorization initialization failed")
	}
	// The privacy service owns the removal ledger, the restore gate and the
	// fence of a deleted account.
	privacyService, err := privacy.Open(ctx, pool, authorizer, privacy.Options{FencePath: cfg.Online.RestoreFencePath})
	if err != nil {
		return nil, nil, errors.New("privacy service initialization failed")
	}
	// The admission check runs before any background work starts, so a
	// database that may not serve traffic never starts a worker or a sweep.
	allowed, err := privacyService.ServingAllowed(ctx)
	if err != nil {
		return nil, nil, errors.New("the removal ledger could not be verified")
	}
	if !allowed {
		return nil, nil, errors.New("the restored database has an unreplayed removal ledger")
	}
	// The private store consults the account gate inside its write
	// transactions, so a deleted account cannot write again.
	store, err := storage.Open(ctx, pool, storage.WithAccountGate(privacyService))
	if err != nil {
		return nil, nil, errors.New("storage initialization failed")
	}
	// The authorization service is the participant authorizer. The writer
	// re-checks it inside every acceptance transaction.
	onlineService, err := online.Open(ctx, pool, evaluator,
		online.WithSeatAuthorizer(authorizer),
		online.WithHealthReporter(health),
		online.WithCancellationClassifier(rulesCancellation),
		online.WithBusyClassifier(rulesBusy),
		online.WithRecoveryGate(),
	)
	if err != nil {
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
		return nil, nil, errors.New("public profile initialization failed")
	}
	// The history service publishes the allowlisted public replay and the
	// public game history of the completed online matches. It writes only its
	// own tables, and it never writes match state.
	historyService, err := history.Open(ctx, pool, profileService, history.Options{})
	if err != nil {
		return nil, nil, errors.New("public history initialization failed")
	}
	root := http.NewServeMux()
	// The online surface carries the participant routes, the feature state
	// and, when the friend switch is on, the friend routes. The feature
	// state is always mounted: the browser asks it before it shows
	// anything, and a configured service origin is not an enablement
	// signal.
	// The configured switches are the defaults; the site owner can override
	// them at runtime, so every switch below reads the live state.
	switches, err := onlineswitch.Open(ctx, pool, onlineswitch.State{Friends: cfg.Online.FriendEnabled, Queue: cfg.Online.QueueEnabled})
	if err != nil {
		return nil, nil, errors.New("online switch initialization failed")
	}
	ownerSwitchable := len(cfg.Online.OwnerAccounts) > 0
	surface := http.NewServeMux()
	surface.Handle("/v1/online/features", httpapi.NewLiveFeatures(func(ctx context.Context) httpapi.OnlineFeatures {
		state := switches.State(ctx)
		return httpapi.OnlineFeatures{Friends: state.Friends, Queue: state.Queue, MCP: cfg.Online.MCPEnabled, Boards: cfg.Online.AgentBoardsEnabled}
	}))
	surface.Handle("/", httpapi.NewOnlineWithPublicReplay(onlineService, authorizer, httpapi.OnlineOptions{AllowedOrigins: cfg.Clerk.AllowedOrigins}, historyService))
	// The friend surface stays mounted even when the switch is off. The
	// switch is a rollback switch: it stops new creations immediately, and
	// an invitation that was issued while it was open must still be
	// finishable. The service refuses the creation of a new invitation
	// while the switch is off, and it serves the preview, the acceptance,
	// the cancellation and the seat recovery of an issued invitation.
	friendService, err := invite.Open(ctx, pool, onlineService, onlineService, onlineauth.NewAllocator(authorizer), invite.Options{
		GuestCredentialTTL: cfg.Online.GuestCredentialTTL,
		InvitationTTL:      invite.InvitationTTL,
		Gate:               switches,
	})
	if err != nil {
		return nil, nil, errors.New("friend invitation initialization failed")
	}
	friendHandler := httpapi.NewFriends(friendService, onlineService, authorizer, httpapi.FriendsOptions{
		AllowedOrigins: cfg.Clerk.AllowedOrigins,
		LabelResolver:  invite.NewAccountLabelResolver(pool),
		// The cohort narrows the accounts that may use the friend surface.
		// It is an allowlist, so an empty cohort admits every signed-in
		// account, and it never excludes a guest.
		Cohort: cfg.Online.FriendCohort,
	})
	surface.Handle("/v1/online/invitations", friendHandler)
	surface.Handle("/v1/online/invitations/", friendHandler)
	surface.Handle("/v1/online/rematches", friendHandler)
	surface.Handle("/v1/online/rematches/", friendHandler)
	surface.Handle("GET /v1/online/matches/{matchID}/rematch", friendHandler)
	root.Handle("/v1/online/", httpapi.CORSWithHeaders(cfg.Clerk.AllowedOrigins, httpapi.OnlineRequestHeaders, surface))
	// The public queue is mounted only when it can be open: when its switch
	// is on, or when an owner can turn it on. A closed surface answers 404.
	var queueService *queue.Service
	if cfg.Online.QueueEnabled || ownerSwitchable {
		// The queue allocates matches through the shared writer. The writer
		// owns the trusted allocation seam, so the queue never writes a
		// match row itself.
		allocator, ok := any(onlineService).(queue.MatchAllocator)
		if !ok {
			return nil, nil, errors.New("the public queue needs the shared match allocator")
		}
		queueService, err = queue.Open(ctx, pool, queue.Options{
			Allocator:   allocator,
			Labels:      invite.NewAccountLabelResolver(pool),
			Credentials: onlineauth.NewAllocator(authorizer),
		})
		if err != nil {
			return nil, nil, errors.New("public queue initialization failed")
		}
		root.Handle("/v1/online/queue/", httpapi.CORSWithHeaders(cfg.Clerk.AllowedOrigins, httpapi.OnlineRequestHeaders,
			whenOpen(switches.QueueEnabled, httpapi.NewQueue(queueService, authorizer, httpapi.QueueOptions{
				AllowedOrigins: cfg.Clerk.AllowedOrigins,
				// The cohort narrows the accounts that may enter the
				// public queue. It is an allowlist, so an empty cohort
				// admits every signed-in account.
				Cohort: cfg.Online.QueueCohort,
			}))))
	}
	// The server engine plays its own seats in the matches created against
	// it. It is started only when its switch is on.
	if cfg.Online.ServerEngineEnabled {
		engineSeats, stopServerEngine, err := openServerEngine(ctx, cfg.Online, pool, onlineService, onlineauth.NewAllocator(authorizer))
		if err != nil {
			return nil, nil, err
		}
		owned.own(stopServerEngine)
		// The remote MCP endpoint is mounted only when its switch is on. A
		// closed endpoint is not mounted at all, so it answers 404.
		if cfg.Online.MCPEnabled {
			agentGames := agentboards.New(pool)
			endpoint, err := mcpserver.New(mcpserver.Options{
				Records:        agentGames,
				Matches:        onlineService,
				Engine:         engineSeats,
				Credentials:    onlineauth.NewAllocator(authorizer),
				Authenticator:  authorizer,
				ActiveGames:    mcpserver.PostgresActiveGames(pool),
				AllowedOrigins: cfg.Clerk.AllowedOrigins,
				TrustProxy:     cfg.Online.MCPTrustProxy,
				MaxActiveGames: cfg.Online.MCPMaxActiveGames,
				StartsPerHour:  cfg.Online.MCPStartsPerHour,
			})
			if err != nil {
				return nil, nil, errors.New("remote MCP initialization failed")
			}
			engineSeats.SetReadiness(endpoint.PlayersReady)
			root.Handle("/v1/mcp", endpoint)
			if cfg.Online.AgentBoardsEnabled {
				root.Handle("/v1/public/agent-boards", httpapi.CORS(cfg.Clerk.AllowedOrigins, agentboards.Handler(agentGames, 30*time.Second)))
			}
		}
	}
	// The public history API is mounted under its own prefix. Its reads need
	// no credential at all.
	root.Handle("/v1/public/", httpapi.CORS(cfg.Clerk.AllowedOrigins, httpapi.NewPublicHistory(historyService)))
	// The privacy API is mounted under its own prefix. It carries the account
	// and the guest credential header, and the private single-owner sync API
	// is never widened to accept them.
	root.Handle("/v1/privacy/", httpapi.CORSWithMethods(cfg.Clerk.AllowedOrigins, httpapi.PrivacyRequestHeaders, "GET, POST, OPTIONS", httpapi.NewPrivacy(privacyService, historyService, authorizer, httpapi.OnlineOptions{AllowedOrigins: cfg.Clerk.AllowedOrigins})))
	// The public profile API is mounted under its own prefixes so it never
	// widens the private single-owner sync API.
	profileHandler := httpapi.CORSWithMethods(cfg.Clerk.AllowedOrigins, httpapi.ProfileRequestHeaders, "GET, POST, PUT, OPTIONS", httpapi.NewProfile(profileService, guestProofIssuer{allocator: onlineauth.NewAllocator(authorizer)}, authorizer, httpapi.OnlineOptions{AllowedOrigins: cfg.Clerk.AllowedOrigins}))
	if ownerSwitchable {
		root.Handle("/v1/account/online-switches", httpapi.CORSWithMethods(cfg.Clerk.AllowedOrigins, httpapi.ProfileRequestHeaders, "GET, PUT, OPTIONS",
			httpapi.NewOwnerSwitches(switches, authorizer, httpapi.OnlineOptions{AllowedOrigins: cfg.Clerk.AllowedOrigins}, cfg.Online.OwnerAccounts)))
	}
	root.Handle("/v1/profiles/", profileHandler)
	root.Handle("/v1/account/", profileHandler)
	root.Handle("/v1/guest-seats/", profileHandler)
	// The private single-owner sync API is fenced: a deleted account cannot
	// read or write its own private archive any more.
	root.Handle("/", httpapi.CORS(cfg.Clerk.AllowedOrigins, httpapi.NewAuthenticatedWithFence(store, verifier, privacyService)))
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
	stopHealth := StartHealthMonitor(ctx, pool, health, onlineService, HealthMonitorConfig{
		Interval: cfg.Online.HealthCheckInterval,
		// The failures of the monitor are the classes of the rules client
		// and the durable state of the service. They carry no secret, so
		// they are logged: a closed gate has to be visible in the log of
		// the instance that closed it.
		OnError: func(err error) {
			slog.Default().Error("the online health check failed", "error", err)
		},
	})
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
	// The serving gate is the admission state of the restored database. A
	// restore that has not replayed the newest removal ledger keeps the
	// service closed, so an erased game is never served again. The check ran
	// before the background work started, and every request is checked again
	// while the service runs.
	handler := httpapi.WithServingGate(privacyService, root)
	release := func() {
		// The loops stop before the pool closes, so no background sweep can
		// use a closed connection.
		stopDeadlines()
		stopHealth()
		stopQueue()
		stopPublishing()
		closeAll()
		pool.Close()
	}
	// The composition is handed over, so the release function owns the
	// resources from now on and the guard of a failed boot stands down.
	booted = true
	return handler, release, nil
}

// openEvaluator creates the rules evaluator of the service.
//
// The worker is warmed at boot, so the health probe never faces a cold
// start. A probe that started the worker would hold the slot of the worker
// for the whole start, and a participant that arrived behind it would run
// out of its own request budget and report an outage that never happened.
//
// A warm that fails stops the boot. The service must never report a
// dependency it could not prove, and the probe cannot repair the failure
// afterwards: the probe of a cold worker cannot tell a busy worker from a
// broken one, so an ignored failure could neither degrade the dependency nor
// recover it.
//
// The closer of the worker is returned even when the warm failed, so the
// owner of the composition releases the worker of the failed boot.
func openEvaluator(ctx context.Context, entry string) (online.Evaluator, func(), error) {
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
	closeClient := func() { _ = client.Close() }
	if err = client.Warm(ctx); err != nil {
		// The boot stops here. The cause is logged for the operator, and the
		// closer of the worker is returned, so the owner of the composition
		// closes and reaps the worker of the failed boot.
		slog.Default().Error("the rules worker did not start at boot", "error", err)
		return nil, closeClient, errors.New("online rules worker did not start at boot")
	}
	return evaluator, closeClient, nil
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

// whenOpen answers 404 while open reports the surface closed, exactly like a
// surface that is not mounted.
func whenOpen(open func() bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !open() {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}
