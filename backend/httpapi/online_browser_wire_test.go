package httpapi

// The wire of the browser runner is proved in both directions.
//
// The fixture is the shared wire fixture of the browser: the browser builds
// the bodies of the lease route and of the uncertain provider request route
// with the production builders and compares them with the very same fixture,
// and this test lets the strict decoder of the service read the bodies of that
// fixture. A body the browser builds and a body the service refuses can
// therefore not pass the tracked suite.

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

const browserBodiesPath = "../online/testdata/online-browser-bodies.json"

func readBrowserBodies(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(browserBodiesPath)
	if err != nil {
		t.Fatalf("the shared wire fixture of the browser is missing: %v", err)
	}
	var bodies map[string]json.RawMessage
	if err := json.Unmarshal(raw, &bodies); err != nil {
		t.Fatalf("the shared wire fixture of the browser is not readable: %v", err)
	}
	return bodies
}

func TestBrowserLeaseBodiesDecodeStrictly(t *testing.T) {
	bodies := readBrowserBodies(t)
	for _, name := range []string{"leaseAcquire", "leaseRenew", "leaseRelease"} {
		body, ok := bodies[name]
		if !ok {
			t.Fatalf("the shared wire fixture of the browser has no body %q", name)
		}
		var decoded runnerLeaseRequestBody
		if err := decodeOnlineBody(body, &decoded); err != nil {
			t.Fatalf("the lease body %q does not decode strictly: %v", name, err)
		}
		if decoded.SchemaVersion != 2 || decoded.Seat != online.SeatWhite {
			t.Fatalf("the lease body %q decoded into %+v", name, decoded)
		}
		if decoded.RunnerID != "runner-tab-01" || decoded.ControlEpoch != 2 {
			t.Fatalf("the lease body %q lost a field: %+v", name, decoded)
		}
		t.Logf("the lease body %q decoded into %+v", name, decoded)
	}
}

func TestBrowserRequestBodiesDecodeStrictly(t *testing.T) {
	bodies := readBrowserBodies(t)
	for _, name := range []string{"requestBegin", "requestClear"} {
		body, ok := bodies[name]
		if !ok {
			t.Fatalf("the shared wire fixture of the browser has no body %q", name)
		}
		decoded, err := online.ParseRunnerRequestEnvelope(body)
		if err != nil {
			t.Fatalf("the request body %q does not decode strictly: %v", name, err)
		}
		if decoded.SchemaVersion != 2 || decoded.Seat != online.SeatWhite {
			t.Fatalf("the request body %q decoded into %+v", name, decoded)
		}
		if decoded.RunnerID != "runner-tab-01" || decoded.ControlEpoch != 2 {
			t.Fatalf("the request body %q lost a field: %+v", name, decoded)
		}
		if decoded.LeaseID != "lease-contract-01" || decoded.RequestID != "request-contract-01" {
			t.Fatalf("the request body %q lost a field: %+v", name, decoded)
		}
		t.Logf("the request body %q decoded into %+v", name, decoded)
	}
}

func TestBrowserUnknownFieldIsRefused(t *testing.T) {
	var body runnerLeaseRequestBody
	err := decodeOnlineBody([]byte(`{"schemaVersion":2,"action":"acquire","seat":"white","runnerId":"r","controlEpoch":1,"generation":7}`), &body)
	if err == nil {
		t.Fatal("the strict decoder accepted a field it does not know")
	}
	t.Logf("the strict decoder refused the unknown field: %v", err)
}
