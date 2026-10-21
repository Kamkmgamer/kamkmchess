package httpapi

import (
	"context"
	"net/http"

	"github.com/Kamkmgamer/kamkmchess/backend/auth"
)

// ServingGate reports whether the service may serve traffic.
//
// The gate is the admission state of the restored database: a restore that
// has not replayed the newest removal ledger keeps the gate closed, so the
// erased game is not served again.
type ServingGate interface {
	ServingAllowed(ctx context.Context) (bool, error)
}

// AccountFence reports whether an account may still use the private store.
//
// The fence is the durable state of a deleted account. A private request of a
// fenced account is refused, even when its session token still verifies.
type AccountFence interface {
	AccountMayUseStore(ctx context.Context, accountID string) (bool, error)
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

// WithAccountFence refuses the private requests of a fenced account.
//
// The fence is checked after the authentication, because the owner of a
// request is the verified identity of its token. A request without a verified
// owner is left to the authentication, which answers it.
func WithAccountFence(fence AccountFence, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fence == nil {
			next.ServeHTTP(w, r)
			return
		}
		owner, ok := auth.Owner(r.Context())
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		allowed, err := fence.AccountMayUseStore(r.Context(), owner)
		if err != nil || !allowed {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}
