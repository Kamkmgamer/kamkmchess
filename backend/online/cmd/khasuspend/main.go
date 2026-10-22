// Command khasuspend plans, recovers and aborts the interruption of a planned
// restart of the online service.
//
// A planned restart is an interruption that an operator announced before the
// service stopped. The announcement is a durable boundary: the durable gate
// of the service closes when the boundary is written, the clock of the
// unfinished matches is refunded for the announced interval, and the
// canonical state is published before the service accepts a resumed action.
//
// The command is private on purpose. There is no public route that plans an
// interruption, because an unauthenticated caller could close the gate of the
// whole service. The database url is read only from the environment variable
// named by --database-url-env, it is never accepted as an argument and it is
// never printed.
//
// Usage:
//
//	khasuspend plan    --database-url-env NAME [--json]
//	khasuspend recover --database-url-env NAME [--boundary-id ID] [--json]
//	khasuspend abort   --database-url-env NAME [--boundary-id ID] [--json]
//	khasuspend status  --database-url-env NAME [--json]
//
// The exit code is 0 when the command did what it was asked and 1 when it
// refused or failed. A refusal never leaves the service in a state the
// operator did not ask for:
//
//   - plan refuses when the database is unreachable and when the environment
//     variable is not set. It never writes a boundary it cannot prove.
//   - recover refuses when no planned interruption is pending: the recovery of
//     an unexpected interruption belongs to the service itself and is never an
//     operator decision.
//   - abort refuses when no planned interruption is pending and when the
//     interruption was applied already. An applied interruption is the
//     published canonical state of the matches and is never undone.
//   - status never writes anything.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	if err := run(context.Background(), os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		fmt.Fprintf(os.Stderr, "khasuspend: %v\n", err)
		os.Exit(1)
	}
}

// run dispatches one command.
func run(ctx context.Context, arguments []string) error {
	if len(arguments) == 0 {
		return errors.New("a command is required: plan, recover, abort or status")
	}
	switch arguments[0] {
	case "plan":
		return planCommand(ctx, arguments[1:])
	case "recover":
		return recoverCommand(ctx, arguments[1:])
	case "abort":
		return abortCommand(ctx, arguments[1:])
	case "status":
		return statusCommand(ctx, arguments[1:])
	case "help", "-h", "--help":
		fmt.Println(strings.TrimSpace(`
khasuspend plans, recovers and aborts the interruption of a planned restart.

  plan    --database-url-env NAME [--json]
  recover --database-url-env NAME [--boundary-id ID] [--json]
  abort   --database-url-env NAME [--boundary-id ID] [--json]
  status  --database-url-env NAME [--json]

The database url is read only from the environment variable named by
--database-url-env. It is never accepted as an argument and never printed.
A plan closes the durable gate of the service, a recover applies the planned
boundary and opens the gate again, and an abort cancels a plan that will not
happen and opens the gate again without refunding a clock.`))
		return nil
	default:
		return fmt.Errorf("unknown command %q", arguments[0])
	}
}

// options are the flags of every command.
type options struct {
	// databaseURLEnv names the environment variable that holds the
	// PostgreSQL url.
	databaseURLEnv string
	// boundaryID names the interruption of a command that acts on one.
	boundaryID string
	// asJSON prints a machine-readable report.
	asJSON bool
}

// parseFlags reads the flags of one command.
func parseFlags(name string, arguments []string) (options, error) {
	var parsed options
	set := flag.NewFlagSet(name, flag.ContinueOnError)
	set.StringVar(&parsed.databaseURLEnv, "database-url-env", "DATABASE_URL", "environment variable holding the PostgreSQL URL")
	set.StringVar(&parsed.boundaryID, "boundary-id", "", "identifier of the interruption the command acts on; the pending one when it is empty")
	set.BoolVar(&parsed.asJSON, "json", false, "print a machine-readable report")
	if err := set.Parse(arguments); err != nil {
		return parsed, err
	}
	if set.NArg() > 0 {
		// The argument is not part of the refusal: a url on the command line
		// is a credential, and a refusal that repeats it would print it.
		return parsed, fmt.Errorf("%s takes no positional argument", name)
	}
	return parsed, nil
}

// databaseURL reads the PostgreSQL url from the named environment variable.
//
// The value is never logged, never included in an error and never persisted.
func databaseURL(name string) (string, error) {
	if name == "" {
		return "", errors.New("--database-url-env is required")
	}
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("environment variable %s is not set; the database url is never read from an argument", name)
	}
	return value, nil
}

// openPool opens the pool of the operator command.
//
// The errors never carry the url, so a failed connection never prints the
// credential of the deployment.
func openPool(ctx context.Context, url string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, errors.New("the database pool could not be created")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("the database is unavailable")
	}
	return pool, nil
}

// openService opens the pool and the online service of the operator command.
//
// The rules process is not part of the operator path: the command plans,
// recovers and aborts an interruption, and it never evaluates a move.
func openService(ctx context.Context, url string) (*pgxpool.Pool, *online.Service, error) {
	pool, err := openPool(ctx, url)
	if err != nil {
		return nil, nil, err
	}
	service, err := online.Open(ctx, pool, nil)
	if err != nil {
		pool.Close()
		return nil, nil, errors.New("the online service could not be opened")
	}
	return pool, service, nil
}

// planCommand persists the planned interruption of a restart.
func planCommand(ctx context.Context, arguments []string) error {
	parsed, err := parseFlags("plan", arguments)
	if err != nil {
		return err
	}
	url, err := databaseURL(parsed.databaseURLEnv)
	if err != nil {
		return err
	}
	pool, service, err := openService(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	// The pending boundary is read before the plan, so the report tells the
	// operator whether the plan created the boundary or reused the one that
	// was already pending.
	pending, err := service.PendingSuspension(ctx)
	if err != nil {
		return err
	}
	reused := pending != nil
	boundary, err := service.PlanSuspendingNow(ctx)
	if err != nil {
		return err
	}
	state, err := online.ServiceGate(ctx, pool)
	if err != nil {
		return err
	}
	report := map[string]any{
		"command":      "plan",
		"boundaryId":   boundary.BoundaryID,
		"kind":         string(boundary.Kind),
		"startedAt":    boundary.StartedAt.Format(time.RFC3339Nano),
		"serviceEpoch": boundary.ServiceEpoch,
		"reused":       reused,
		"gateOpen":     state.Open,
		"gateReason":   state.Reason,
	}
	return emit(parsed.asJSON, report, func() {
		fmt.Printf("planned the interruption %s\n  kind %s\n  started %s\n  service epoch %d\n  reused an existing plan: %t\n",
			boundary.BoundaryID, boundary.Kind, boundary.StartedAt.Format(time.RFC3339), boundary.ServiceEpoch, reused)
		fmt.Printf("the durable gate is %s\n", gateText(state))
	})
}

// recoverCommand applies the planned interruption.
func recoverCommand(ctx context.Context, arguments []string) error {
	parsed, err := parseFlags("recover", arguments)
	if err != nil {
		return err
	}
	url, err := databaseURL(parsed.databaseURLEnv)
	if err != nil {
		return err
	}
	pool, service, err := openService(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	boundaryID, err := targetBoundary(ctx, service, parsed.boundaryID)
	if err != nil {
		return err
	}
	plan, err := service.RecoverPlannedSuspension(ctx, boundaryID)
	if err != nil {
		return err
	}
	state, err := online.ServiceGate(ctx, pool)
	if err != nil {
		return err
	}
	report := map[string]any{
		"command":          "recover",
		"boundaryId":       plan.BoundaryID,
		"kind":             string(plan.Kind),
		"serviceEpoch":     plan.ServiceEpoch,
		"interruptionMs":   plan.InterruptionMs,
		"adjustedMatches":  plan.AdjustedMatches,
		"preservedResults": plan.PreservedResults,
		"revokedLeases":    plan.RevokedLeases,
		"alreadyAdjusted":  plan.AlreadyAdjusted,
		"gateOpen":         state.Open,
		"gateReason":       state.Reason,
	}
	return emit(parsed.asJSON, report, func() {
		fmt.Printf("recovered the interruption %s\n  kind %s\n  interruption %d ms\n  service epoch %d\n  adjusted %d unfinished match(es), preserved %d finished one(s), fenced %d runner lease(s)\n",
			plan.BoundaryID, plan.Kind, plan.InterruptionMs, plan.ServiceEpoch, plan.AdjustedMatches, plan.PreservedResults, plan.RevokedLeases)
		fmt.Printf("the durable gate is %s\n", gateText(state))
	})
}

// abortCommand cancels a planned interruption that will not happen.
func abortCommand(ctx context.Context, arguments []string) error {
	parsed, err := parseFlags("abort", arguments)
	if err != nil {
		return err
	}
	url, err := databaseURL(parsed.databaseURLEnv)
	if err != nil {
		return err
	}
	pool, service, err := openService(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	boundaryID, err := targetBoundary(ctx, service, parsed.boundaryID)
	if err != nil {
		return err
	}
	boundary, err := service.AbortPlannedSuspension(ctx, boundaryID)
	if err != nil {
		return err
	}
	state, err := online.ServiceGate(ctx, pool)
	if err != nil {
		return err
	}
	report := map[string]any{
		"command":    "abort",
		"boundaryId": boundary.BoundaryID,
		"kind":       string(boundary.Kind),
		"abortedAt":  boundary.AbortedAt.Format(time.RFC3339Nano),
		"gateOpen":   state.Open,
		"gateReason": state.Reason,
	}
	return emit(parsed.asJSON, report, func() {
		fmt.Printf("aborted the planned interruption %s\n  aborted %s\n", boundary.BoundaryID, boundary.AbortedAt.Format(time.RFC3339))
		fmt.Printf("the durable gate is %s\n", gateText(state))
	})
}

// statusCommand reports the durable admission state of the service.
func statusCommand(ctx context.Context, arguments []string) error {
	parsed, err := parseFlags("status", arguments)
	if err != nil {
		return err
	}
	url, err := databaseURL(parsed.databaseURLEnv)
	if err != nil {
		return err
	}
	pool, service, err := openService(ctx, url)
	if err != nil {
		return err
	}
	defer pool.Close()
	state, err := online.ServiceGate(ctx, pool)
	if err != nil {
		return err
	}
	pending, err := service.PendingSuspension(ctx)
	if err != nil {
		return err
	}
	epoch, err := service.ServiceEpoch(ctx)
	if err != nil {
		return err
	}
	report := map[string]any{
		"command":         "status",
		"gateOpen":        state.Open,
		"gateReason":      state.Reason,
		"serviceEpoch":    epoch,
		"pendingBoundary": nil,
	}
	if pending != nil {
		report["pendingBoundary"] = map[string]any{
			"boundaryId": pending.BoundaryID,
			"kind":       string(pending.Kind),
			"startedAt":  pending.StartedAt.Format(time.RFC3339Nano),
		}
	}
	return emit(parsed.asJSON, report, func() {
		fmt.Printf("the durable gate is %s\n", gateText(state))
		fmt.Printf("service epoch %d\n", epoch)
		if pending == nil {
			fmt.Println("no planned interruption is pending")
			return
		}
		fmt.Printf("pending interruption %s\n  kind %s\n  started %s\n", pending.BoundaryID, pending.Kind, pending.StartedAt.Format(time.RFC3339))
	})
}

// targetBoundary names the interruption a command acts on.
//
// An empty identifier means the pending planned interruption, so the operator
// does not have to copy an identifier out of a report.
func targetBoundary(ctx context.Context, service *online.Service, boundaryID string) (string, error) {
	if boundaryID != "" {
		return boundaryID, nil
	}
	pending, err := service.PendingSuspension(ctx)
	if err != nil {
		return "", err
	}
	if pending == nil {
		return "", errors.New("no planned interruption is pending; the service has nothing to recover and nothing to abort")
	}
	return pending.BoundaryID, nil
}

// gateText describes the durable admission state of the service.
func gateText(state online.GateState) string {
	if state.Open {
		return "open"
	}
	return fmt.Sprintf("closed (%s)", state.Reason)
}

// emit prints the report of a command.
func emit(asJSON bool, report map[string]any, text func()) error {
	if asJSON {
		encoder := json.NewEncoder(os.Stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	}
	text()
	return nil
}
