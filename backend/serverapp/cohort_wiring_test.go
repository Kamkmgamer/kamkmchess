package serverapp

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// The composition wiring of the account cohorts.
//
// The release gate of the cohort may not report an enforcement it did not
// observe, so the wiring of the composition has to be provable. The proof
// reads the source of the composition with the parser of Go, so it sees the
// code and not a text: a commented out assignment is not a call, and a
// string that names the assignment is not a call either.
//
// The test prints a marker for every surface it proved. The audit of the
// cohort requires the marker, so a tree without the proof, a tree with a
// proof that proves nothing, and a tree whose composition lost the wiring
// all leave the gate blocked.

// The marker of a proved surface. The audit of the cohort reads it from the
// output of the enforcement tests.
const cohortWiringMarker = "COHORT-WIRING"

// cohortWiringSurface is one surface of the composition and the facts that
// prove its cohort.
type cohortWiringSurface struct {
	// surface is the name of the surface.
	surface string
	// setting is the environment variable of the cohort.
	setting string
	// field is the field of the online configuration that carries the
	// cohort.
	field string
	// constructor is the constructor of the surface.
	constructor string
	// options is the type of the options of the surface.
	options string
	// requestPath is the file of the request path of the surface.
	requestPath string
}

// cohortWiringSurfaces are the surfaces that carry a cohort.
var cohortWiringSurfaces = []cohortWiringSurface{
	{surface: "friend", setting: "ONLINE_FRIEND_COHORT", field: "FriendCohort", constructor: "NewFriends", options: "FriendsOptions", requestPath: "../httpapi/friends.go"},
	{surface: "queue", setting: "ONLINE_QUEUE_COHORT", field: "QueueCohort", constructor: "NewQueue", options: "QueueOptions", requestPath: "../httpapi/queue.go"},
}

// TestTheCohortCompositionWiresTheCohortIntoTheRequestPath covers the
// wiring of the composition.
//
// The proof has four parts for every surface: the server reads the setting
// into the online configuration, the configuration carries the cohort, the
// composition hands the cohort of the configuration to the constructor of the
// surface, and the request path of the surface asks the cohort.
//
// Every part is read from the source with the parser of Go, so a commented
// out line is not a call and a string that names a call is not a call
// either. The composition that loses the wiring fails this test, and the
// audit of the cohort reads the failure as a blocker.
func TestTheCohortCompositionWiresTheCohortIntoTheRequestPath(t *testing.T) {
	composition := parseCohortSource(t, "server.go")
	for _, surface := range cohortWiringSurfaces {
		if !compositionReadsCohortSetting(composition, surface.setting, surface.field) {
			t.Fatalf("the composition never reads %s into the online configuration", surface.setting)
		}
		if !compositionPassesCohort(composition, surface.constructor, surface.options, "cfg.Online."+surface.field) {
			t.Fatalf("the composition does not hand cfg.Online.%s to the %s surface", surface.field, surface.surface)
		}
		path := parseCohortSource(t, surface.requestPath)
		if !requestPathAsksCohort(path) {
			t.Fatalf("the request path of the %s surface never asks the cohort", surface.surface)
		}
		t.Logf("%s %s=proven", cohortWiringMarker, surface.surface)
	}
}

// parseCohortSource parses one source file of the tree.
//
// The test reads the source of the composition and of the request path, so
// the proof follows the code that runs and not a copy of it.
func parseCohortSource(t *testing.T, path string) *ast.File {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return file
}

// compositionReadsCohortSetting reports whether the composition reads the
// setting into the field of the online configuration.
//
// The proof needs the whole chain: the setting is read, and the value of the
// field is the parsed setting. A composition that reads the setting and
// stores another value fails.
func compositionReadsCohortSetting(file *ast.File, setting, field string) bool {
	reads := false
	stores := false
	ast.Inspect(file, func(node ast.Node) bool {
		literal, ok := node.(*ast.CompositeLit)
		if !ok || !isTypeNamed(literal.Type, "OnlineConfig") {
			return true
		}
		for _, element := range literal.Elts {
			keyValue, ok := element.(*ast.KeyValueExpr)
			if !ok {
				continue
			}
			key, ok := keyValue.Key.(*ast.Ident)
			if !ok || key.Name != field {
				continue
			}
			call, ok := keyValue.Value.(*ast.CallExpr)
			if !ok {
				continue
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "Parse" {
				continue
			}
			for _, argument := range call.Args {
				if containsStringLiteral(argument, setting) {
					stores = true
				}
			}
		}
		return true
	})
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		for _, argument := range call.Args {
			literal, ok := argument.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				continue
			}
			if strings.Trim(literal.Value, `"`) == setting {
				reads = true
			}
		}
		return true
	})
	return reads && stores
}

// compositionPassesCohort reports whether the composition hands the cohort of
// the configuration to the constructor of the surface.
//
// The options of the surface are a composite literal, and the cohort is one
// of its fields. The value of the field has to be the cohort of the online
// configuration, so a composition that hands another value fails.
func compositionPassesCohort(file *ast.File, constructor, options, cohort string) bool {
	found := false
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != constructor {
			return true
		}
		for _, argument := range call.Args {
			literal, ok := argument.(*ast.CompositeLit)
			if !ok || !isTypeNamed(literal.Type, options) {
				continue
			}
			for _, element := range literal.Elts {
				keyValue, ok := element.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				key, ok := keyValue.Key.(*ast.Ident)
				if !ok || key.Name != "Cohort" {
					continue
				}
				if selectorPath(keyValue.Value) == cohort {
					found = true
				}
			}
		}
		return true
	})
	return found
}

// requestPathAsksCohort reports whether the request path asks the cohort.
//
// The request path of the surface has to hand the cohort of its options to
// the authorization seam, so the narrowing happens before the service is
// called.
func requestPathAsksCohort(file *ast.File) bool {
	found := false
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		identifier, ok := call.Fun.(*ast.Ident)
		if !ok || (identifier.Name != "allowParticipant" && identifier.Name != "participantAllowed") {
			return true
		}
		for _, argument := range call.Args {
			path := selectorPath(argument)
			if strings.HasSuffix(path, ".Cohort") {
				found = true
			}
		}
		return true
	})
	return found
}

// containsStringLiteral reports whether the expression names the string.
//
// The value of the setting is read through a call, so the literal is
// somewhere inside the expression and not always an argument of it.
func containsStringLiteral(expression ast.Expr, value string) bool {
	found := false
	ast.Inspect(expression, func(node ast.Node) bool {
		literal, ok := node.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		if strings.Trim(literal.Value, `"`) == value {
			found = true
		}
		return true
	})
	return found
}

// isTypeNamed reports whether the type is the named type of the package.
func isTypeNamed(expression ast.Expr, name string) bool {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name == name
	case *ast.SelectorExpr:
		return typed.Sel.Name == name
	default:
		return false
	}
}

// selectorPath names the selector chain of an expression.
//
// The chain is the dotted path of the identifiers, so a value of the
// configuration reads as "cfg.Online.FriendCohort".
func selectorPath(expression ast.Expr) string {
	switch typed := expression.(type) {
	case *ast.Ident:
		return typed.Name
	case *ast.SelectorExpr:
		base := selectorPath(typed.X)
		if base == "" {
			return typed.Sel.Name
		}
		return base + "." + typed.Sel.Name
	default:
		return ""
	}
}
