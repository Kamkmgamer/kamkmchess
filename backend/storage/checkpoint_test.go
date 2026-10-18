package storage

import (
	"encoding/json"
	"os"
	"testing"
)

func TestCurrentBrowserCheckpointExtensions(t *testing.T) {
	raw, err := os.ReadFile("testdata/browser-checkpoint.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := validateCheckpoint(raw, "browser-game", "user_fixture"); err != nil {
		t.Fatalf("current browser checkpoint rejected: %v", err)
	}
	var checkpoint map[string]json.RawMessage
	if err := json.Unmarshal(raw, &checkpoint); err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		extensions string
		valid      bool
	}{
		"empty legacy state":        {`{}`, true},
		"opaque versioned state":    {`{"future-feature":{"version":2,"data":{"records":[null,1,"text"]}}}`, true},
		"missing data":              {`{"feature":{"version":1}}`, false},
		"extra section field":       {`{"feature":{"version":1,"data":null,"other":true}}`, false},
		"invalid version":           {`{"feature":{"version":0,"data":null}}`, false},
		"fractional version":        {`{"feature":{"version":1.5,"data":null}}`, false},
		"string version":            {`{"feature":{"version":"1","data":null}}`, false},
		"null extensions":           {`null`, false},
		"nested provider key":       {`{"feature":{"version":1,"data":[{"API_KEY":"fixture"}]}}`, false},
		"nested authorization":      {`{"feature":{"version":1,"data":{"nested":{"authorization":"fixture"}}}}`, false},
		"credentials in undo state": {`{"undo-baseline":{"version":1,"data":{"extensions":{"credentials":{"version":1,"data":null}}}}}`, false},
		"secret section name":       {`{"provider-secret":{"version":1,"data":null}}`, false},
	} {
		t.Run(name, func(t *testing.T) {
			checkpoint["extensions"] = json.RawMessage(tc.extensions)
			data, err := json.Marshal(checkpoint)
			if err != nil {
				t.Fatal(err)
			}
			if valid := validateCheckpoint(data, "browser-game", "user_fixture") == nil; valid != tc.valid {
				t.Fatalf("accepted=%v, want %v", valid, tc.valid)
			}
		})
	}
}

func TestHistoryBindingIsCompleteOrLocal(t *testing.T) {
	for _, tc := range []struct {
		binding string
		valid   bool
	}{
		{`{"providerId":null,"modelRoutingId":null,"connectionRevision":null}`, true},
		{`{"providerId":"openai","modelRoutingId":"model","connectionRevision":0}`, true},
		{`{"providerId":"openai","modelRoutingId":null,"connectionRevision":null}`, false},
		{`{"providerId":null,"modelRoutingId":"model","connectionRevision":1}`, false},
		{`{"providerId":"openai","modelRoutingId":"model","connectionRevision":null}`, false},
	} {
		var segment map[string]json.RawMessage
		if err := json.Unmarshal([]byte(tc.binding), &segment); err != nil {
			t.Fatal(err)
		}
		if validHistoryBinding(segment) != tc.valid {
			t.Fatalf("invalid binding result for %s", tc.binding)
		}
	}
}
