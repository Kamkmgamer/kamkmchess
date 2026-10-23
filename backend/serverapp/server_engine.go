package serverapp

import (
	"context"
	"errors"
	"time"

	"github.com/Kamkmgamer/kamkmchess/backend/engine"
	"github.com/Kamkmgamer/kamkmchess/backend/serverengine"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The server engine defaults.
const (
	DefaultServerEngineSlots         = 2
	DefaultServerEngineSweepInterval = 500 * time.Millisecond
	serverEngineSweepBatch           = 64
	DefaultMCPMaxActiveGames         = 50
	DefaultMCPStartsPerHour          = 20
)

// openServerEngine starts the native engine pool and the loop that plays the
// server engine seats, and returns the driver that creates matches against it. The returned stop function waits for the moves in
// flight and then stops the engine processes.
func openServerEngine(ctx context.Context, cfg OnlineConfig, pool *pgxpool.Pool, matches serverengine.Matches, credentials serverengine.Credentials) (*serverengine.Service, func(), error) {
	engines, err := engine.Open(ctx, engine.Config{Path: cfg.ServerEnginePath, Size: cfg.ServerEngineSlots})
	if err != nil {
		return nil, nil, errors.New("the server engine could not start")
	}
	driver, err := serverengine.New(serverengine.Options{
		Matches:     matches,
		Credentials: credentials,
		Mover:       engines,
		ActiveSeats: serverengine.PostgresSeats(pool),
		MaxInFlight: 4 * cfg.ServerEngineSlots,
	})
	if err != nil {
		engines.Close()
		return nil, nil, err
	}
	stop := driver.Start(ctx, cfg.ServerEngineSweepInterval, serverEngineSweepBatch)
	return driver, func() {
		stop()
		engines.Close()
	}, nil
}
