package auth

import (
	"net/http"
	"strings"
)

// Middleware requires a valid Clerk session JWT. Authentication failures share
// one response so token parsing, lookup, and key-service details are not exposed.
func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		values := r.Header.Values("Authorization")
		fields := strings.Fields(r.Header.Get("Authorization"))
		if len(values) != 1 || len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") {
			unauthorized(w)
			return
		}
		origins := r.Header.Values("Origin")
		if len(origins) > 1 {
			unauthorized(w)
			return
		}
		claims, err := v.Verify(r.Context(), fields[1], r.Header.Get("Origin"))
		if err != nil {
			unauthorized(w)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithOwner(r.Context(), claims.Subject)))
	})
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
}
