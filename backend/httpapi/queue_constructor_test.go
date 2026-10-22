package httpapi

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// The constructor of the public queue is the seam where the cohort of the
// surface can be lost.
//
// The queue narrows the accounts that may enter it, and the narrowing is a
// property of the request path. A second constructor that took the options
// of another surface would drop the cohort on the way in and would admit
// every signed-in account, so the package carries exactly one constructor and
// that constructor takes the options of the queue.

// queueConstructor is one constructor of the public queue.
type queueConstructor struct {
	name       string
	parameters []string
	// carriesOptions reports whether the constructor hands its options to
	// the request path.
	carriesOptions bool
}

// queueConstructors reads the constructors of the public queue from the
// sources of the package.
//
// The test reads the source of its own package, so a second constructor
// cannot hide from it.
func queueConstructors(t *testing.T) []queueConstructor {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read the package directory: %v", err)
	}
	found := []queueConstructor{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv != nil {
				continue
			}
			if !strings.HasPrefix(function.Name.Name, "NewQueue") {
				continue
			}
			constructor := queueConstructor{name: function.Name.Name}
			if function.Type.Params != nil {
				for _, field := range function.Type.Params.List {
					constructor.parameters = append(constructor.parameters, queueTypeName(field.Type))
				}
			}
			constructor.carriesOptions = queueCarriesOptions(function)
			found = append(found, constructor)
		}
	}
	return found
}

// queueTypeName names the type of a parameter.
func queueTypeName(expression ast.Expr) string {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.SelectorExpr:
		return typed.Sel.Name
	default:
		return ""
	}
}

// queueCarriesOptions reports whether the constructor hands its options to
// the request path.
//
// The options of the queue carry the cohort, so the constructor has to put
// them into the API that answers the requests. A constructor that drops them
// admits every account.
func queueCarriesOptions(function *ast.FuncDecl) bool {
	carries := false
	ast.Inspect(function.Body, func(node ast.Node) bool {
		literal, ok := node.(*ast.CompositeLit)
		if !ok {
			return true
		}
		for _, element := range literal.Elts {
			keyValue, ok := element.(*ast.KeyValueExpr)
			if !ok {
				continue
			}
			key, ok := keyValue.Key.(*ast.Ident)
			if !ok || key.Name != "options" {
				continue
			}
			if value, ok := keyValue.Value.(*ast.Ident); ok && value.Name == "options" {
				carries = true
			}
		}
		return true
	})
	return carries
}

// TestTheCohortSurvivesEveryQueueConstructor covers the constructor of the
// public queue.
//
// The package carries exactly one constructor of the queue, it takes the
// options of the queue, and it hands them to the request path. A second
// constructor that dropped the cohort would admit every signed-in account,
// so the test fails when one appears.
func TestTheCohortSurvivesEveryQueueConstructor(t *testing.T) {
	constructors := queueConstructors(t)
	if len(constructors) != 1 {
		names := []string{}
		for _, constructor := range constructors {
			names = append(names, constructor.name)
		}
		t.Fatalf("the package carries %d constructors of the public queue (%s), want exactly one", len(constructors), strings.Join(names, ", "))
	}
	constructor := constructors[0]
	if constructor.name != "NewQueue" {
		t.Fatalf("the constructor is named %q, want NewQueue", constructor.name)
	}
	want := []string{"QueueService", "OnlineAuthenticator", "QueueOptions"}
	if len(constructor.parameters) != len(want) {
		t.Fatalf("the constructor takes %v, want %v", constructor.parameters, want)
	}
	for index, parameter := range want {
		if constructor.parameters[index] != parameter {
			t.Fatalf("the parameter %d is %q, want %q", index, constructor.parameters[index], parameter)
		}
	}
	if !constructor.carriesOptions {
		t.Fatal("the constructor does not hand its options to the request path, so the cohort would be dropped")
	}
}
