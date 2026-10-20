package httpapi

import (
	"context"
	"net/http"
)

// ServingGate reports whether the service may serve traffic.
//
// The gate is the admission state of the restored database: a restore that
// has not replayed the newest removal ledger keeps the gate closed, so the
// erased game is not served again.
type ServingGate interface {
	ServingAllowed(ctx context.Context) (bool, error)
}

// WithServingGate blocks every request while the service may not serve
// traffic.
//
// The check fails closed: a gate that cannot be read is a closed gate. The
// answer is a retryable failure, because the state is a temporary condition
// of the service and not a refusal of the request.
func WithServingGate(gate ServingGate, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gate == nil {
			next.ServeHTTP(w, r)
			return
		}
		allowed, err := gate.ServingAllowed(r.Context())
		if err != nil || !allowed {
			writeError(w, http.StatusServiceUnavailable, "restore_pending")
			return
		}
		next.ServeHTTP(w, r)
	})
}
