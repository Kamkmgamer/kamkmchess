package serverapp

import "testing"

func TestLoadKeepsTheServerEngineAndMCPClosedAndDependent(t *testing.T) {
	values := map[string]string{
		"DATABASE_URL":              "postgres://local/fixture",
		"CLERK_ISSUER":              "https://fixture.clerk.accounts.dev",
		"CLERK_JWKS_URL":            "https://fixture.clerk.accounts.dev/.well-known/jwks.json",
		"CLERK_AUTHORIZED_PARTIES":  "https://chess.example",
		"APP_ALLOWED_ORIGINS":       "https://chess.example",
		"ONLINE_RESTORE_FENCE_PATH": "/var/lib/kamkmchess/restore-fence",
	}
	load := func() (Config, error) { return Load(func(key string) string { return values[key] }) }
	cfg, err := load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Online.ServerEngineEnabled || cfg.Online.MCPEnabled || cfg.Online.MCPTrustProxy {
		t.Fatalf("a switch was on by default: %+v", cfg.Online)
	}
	// The endpoint needs the server engine, and the engine needs a path.
	values["ONLINE_MCP_ENABLED"] = "1"
	if _, err = load(); err == nil {
		t.Fatal("the MCP endpoint loaded without the server engine")
	}
	values["ONLINE_SERVER_ENGINE_ENABLED"] = "1"
	if _, err = load(); err == nil {
		t.Fatal("the server engine loaded without an engine path")
	}
	values["ONLINE_SERVER_ENGINE_PATH"] = "/usr/games/stockfish"
	if cfg, err = load(); err != nil || !cfg.Online.MCPEnabled || cfg.Online.MCPMaxActiveGames != DefaultMCPMaxActiveGames {
		t.Fatalf("the full configuration = %+v, %v", cfg.Online, err)
	}
}
