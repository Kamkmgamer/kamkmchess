package online

import (
	"strings"
	"testing"
)

// TestParseRunnerRequestEnvelopeIsStrict covers the shared provider request
// envelope.
//
// The browser runner and the service read the same envelope, so an unknown
// field, a wrong action or a missing identity is refused in both.
func TestParseRunnerRequestEnvelopeIsStrict(t *testing.T) {
	valid := `{"schemaVersion":2,"action":"begin","seat":"white","runnerId":"runner-tab-01","leaseId":"lease-contract-01","requestId":"request-contract-01","controlEpoch":2,"turnVersion":4}`
	envelope, err := ParseRunnerRequestEnvelope([]byte(valid))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if envelope.Action != RunnerRequestBegin || envelope.Seat != SeatWhite {
		t.Fatalf("the envelope = %+v", envelope)
	}
	if envelope.RunnerID != "runner-tab-01" || envelope.LeaseID != "lease-contract-01" {
		t.Fatalf("the envelope = %+v", envelope)
	}
	if envelope.RequestID != "request-contract-01" || envelope.ControlEpoch != 2 || envelope.TurnVersion != 4 {
		t.Fatalf("the envelope = %+v", envelope)
	}
	refused := []string{
		`{"schemaVersion":2,"action":"begin","seat":"white","runnerId":"runner-tab-01","leaseId":"lease-contract-01","requestId":"request-contract-01","controlEpoch":2,"turnVersion":4,"extra":true}`,
		`{"schemaVersion":1,"action":"begin","seat":"white","runnerId":"runner-tab-01","leaseId":"lease-contract-01","requestId":"request-contract-01","controlEpoch":2,"turnVersion":4}`,
		`{"schemaVersion":2,"action":"cancel","seat":"white","runnerId":"runner-tab-01","leaseId":"lease-contract-01","requestId":"request-contract-01","controlEpoch":2,"turnVersion":4}`,
		`{"schemaVersion":2,"action":"begin","seat":"green","runnerId":"runner-tab-01","leaseId":"lease-contract-01","requestId":"request-contract-01","controlEpoch":2,"turnVersion":4}`,
		`{"schemaVersion":2,"action":"begin","seat":"black","runnerId":"","leaseId":"lease-contract-01","requestId":"request-contract-01","controlEpoch":2,"turnVersion":4}`,
		`{"schemaVersion":2,"action":"begin","seat":"white","runnerId":"runner-tab-01","leaseId":"short","requestId":"request-contract-01","controlEpoch":2,"turnVersion":4}`,
		`{"schemaVersion":2,"action":"begin","seat":"white","runnerId":"runner-tab-01","leaseId":"lease-contract-01","requestId":"request-contract-01","controlEpoch":0,"turnVersion":4}`,
		valid + `{}`,
	}
	for _, body := range refused {
		if _, err := ParseRunnerRequestEnvelope([]byte(body)); err == nil {
			t.Fatalf("the envelope %q was accepted", body)
		}
	}
}

// TestRunnerRequestEnvelopeFixtureMatchesTheContract keeps the shared
// fixture and the Go envelope in step.
func TestRunnerRequestEnvelopeFixtureMatchesTheContract(t *testing.T) {
	fixture := loadFixture(t)
	if fixture.RunnerRequest.SchemaVersion != ContractsSchemaVersion {
		t.Fatalf("the fixture schema version = %d", fixture.RunnerRequest.SchemaVersion)
	}
	if err := fixture.RunnerRequest.Validate(); err != nil {
		t.Fatalf("the fixture envelope: %v", err)
	}
	if !strings.HasPrefix(fixture.RunnerRequest.Action, "b") && !strings.HasPrefix(fixture.RunnerRequest.Action, "c") {
		t.Fatalf("the fixture action = %q", fixture.RunnerRequest.Action)
	}
}
