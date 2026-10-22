package main

import (
	"context"
	"os"
	"strings"
	"testing"
)

// The refusals of the operator command.
//
// The command is private: the database url comes from a named environment
// variable, the command never accepts one as an argument and it never prints
// one. The refusals below are the offline part of that contract: they need no
// database, no network and no credential.

// TestTheOperatorCommandNeedsTheNamedEnvironmentVariable covers the secret.
//
// The url of the database is read only from the environment variable that
// the operator names. A command without that variable refuses, and the
// refusal names the variable without ever printing a value.
func TestTheOperatorCommandNeedsTheNamedEnvironmentVariable(t *testing.T) {
	const name = "KHA_OPERATOR_MISSING_URL"
	t.Setenv(name, "")
	if err := os.Unsetenv(name); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"plan", "recover", "abort", "status"} {
		err := run(context.Background(), []string{command, "--database-url-env", name})
		if err == nil {
			t.Fatalf("the command %q ran without the named environment variable", command)
		}
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("the refusal of the command %q does not name the variable: %v", command, err)
		}
	}
}

// TestTheOperatorCommandRefusesAConnectionStringAsAnArgument covers the
// boundary of the secret.
//
// A url on the command line would end up in the shell history and in the
// process list of the host, so the command refuses a positional argument.
func TestTheOperatorCommandRefusesAConnectionStringAsAnArgument(t *testing.T) {
	err := run(context.Background(), []string{"plan", "postgres://user:secret@127.0.0.1:5432/kamkmchess"})
	if err == nil {
		t.Fatal("the command accepted a connection string as an argument")
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("the refusal printed the credential: %v", err)
	}
}

// TestTheOperatorCommandRefusesAnUnknownCommand covers the dispatch.
//
// An unknown command is an error, never a silent success: an operator who
// mistyped a command must not read the exit code of a run that did nothing.
func TestTheOperatorCommandRefusesAnUnknownCommand(t *testing.T) {
	err := run(context.Background(), []string{"suspend"})
	if err == nil {
		t.Fatal("the command accepted an unknown command")
	}
	if !strings.Contains(err.Error(), "suspend") {
		t.Fatalf("the refusal does not name the command: %v", err)
	}
	err = run(context.Background(), nil)
	if err == nil {
		t.Fatal("the command accepted an empty argument list")
	}
}

// TestTheOperatorCommandNeedsTheDatabaseURLFlag covers the flags.
//
// The name of the environment variable is required, so a command that runs
// without it never guesses a variable of the host.
func TestTheOperatorCommandNeedsTheDatabaseURLFlag(t *testing.T) {
	if _, err := databaseURL(""); err == nil {
		t.Fatal("the command accepted an empty name of the environment variable")
	}
}
