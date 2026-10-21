package online

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// The browser agent runner leases.
//
// One lease holds the right to act for one seat of one match. The lease is
// per seat and per turn: it binds a runner to a seat, to the turn it was
// taken for, and to the control epoch of that turn. A control change, a
// human takeover, an agent handoff, and a model or connection switch all
// advance the control epoch, and the old lease is fenced with it.
//
// A lease holds no credential, no provider route, no model conversation and
// no archive reference. It records the identity of a browser runner and the
// opaque identifier of a provider request that may still be running, so a new
// runner can tell that the previous runner may have started billable work.
//
// The lease is the server-authoritative fence of the runner. The acceptance
// transaction checks it, so a reply from a superseded runner can never become
// an accepted move, and duplicate tabs of one owner can never both submit.

// RunnerLeaseTTL is how long a runner lease holds without a renewal.
const RunnerLeaseTTL = 30 * time.Second

// The reasons a lease ended.
const (
	// LeaseRevokeReleased marks a lease the runner gave up.
	LeaseRevokeReleased = "released"
	// LeaseRevokeControlChange marks a lease that a control change fenced.
	LeaseRevokeControlChange = "control_change"
	// LeaseRevokeRecovery marks a lease that a service recovery fenced.
	LeaseRevokeRecovery = "recovery"
	// LeaseRevokeMatchEnded marks a lease of a finished match.
	LeaseRevokeMatchEnded = "match_ended"
)

// RunnerLeaseRequest is the request envelope of a lease operation.
//
// The lease operations are idempotent by construction: an acquire by the
// runner that already holds the lease returns that lease, a renewal of a
// revoked lease is refused instead of reviving it, and a release of a revoked
// lease returns the stored lease.
type RunnerLeaseRequest struct {
	// SchemaVersion is the contract version of the request.
	SchemaVersion int `json:"schemaVersion"`
	// MatchID is the match the lease belongs to.
	MatchID string `json:"matchId"`
	// Seat is the seat the lease acts for.
	Seat Seat `json:"seat"`
	// RunnerID identifies the browser runner. It is opaque to the server.
	RunnerID string `json:"runnerId"`
	// LeaseID names the lease a renewal or a release acts on.
	LeaseID string `json:"leaseId,omitempty"`
	// TurnVersion is the match version the runner acts for. It is the turn
	// the lease is bound to, and a lease of an older turn cannot act on a
	// later one.
	TurnVersion int64 `json:"turnVersion,omitempty"`
	// ControlEpoch is the control epoch the runner believes is current. A
	// runner that did not see the latest control change is refused, so a
	// superseded runner cannot renew or take a lease.
	ControlEpoch int64 `json:"controlEpoch"`
}

// RunnerRequestRequest is the request envelope of the uncertain provider
// request record.
type RunnerRequestRequest struct {
	// SchemaVersion is the contract version of the request.
	SchemaVersion int `json:"schemaVersion"`
	// MatchID is the match the request belongs to.
	MatchID string `json:"matchId"`
	// Seat is the seat the request belongs to.
	Seat Seat `json:"seat"`
	// RunnerID identifies the browser runner.
	RunnerID string `json:"runnerId"`
	// LeaseID names the lease the request belongs to.
	LeaseID string `json:"leaseId"`
	// RequestID is the opaque identifier of the provider request.
	RequestID string `json:"requestId"`
	// ControlEpoch is the control epoch the runner believes is current.
	ControlEpoch int64 `json:"controlEpoch"`
	// TurnVersion is the match version the runner acts for.
	TurnVersion int64 `json:"turnVersion,omitempty"`
}

// Validate checks the lease request envelope.
func (r RunnerLeaseRequest) Validate() error {
	if r.SchemaVersion != ContractsSchemaVersion {
		return fmt.Errorf("%w: runner lease schema version", ErrInvalidContract)
	}
	if !idPattern.MatchString(r.MatchID) {
		return fmt.Errorf("%w: runner lease match id", ErrInvalidContract)
	}
	if r.Seat != SeatWhite && r.Seat != SeatBlack {
		return fmt.Errorf("%w: runner lease seat", ErrInvalidContract)
	}
	if !runnerIDShape(r.RunnerID) {
		return fmt.Errorf("%w: runner id", ErrInvalidContract)
	}
	if r.LeaseID != "" && !idPattern.MatchString(r.LeaseID) {
		return fmt.Errorf("%w: runner lease id", ErrInvalidContract)
	}
	if r.TurnVersion < 0 {
		return fmt.Errorf("%w: runner lease turn version", ErrInvalidContract)
	}
	if r.ControlEpoch < 1 {
		return fmt.Errorf("%w: runner lease control epoch", ErrInvalidContract)
	}
	return nil
}

// Validate checks the uncertain request envelope.
func (r RunnerRequestRequest) Validate() error {
	if r.SchemaVersion != ContractsSchemaVersion {
		return fmt.Errorf("%w: runner request schema version", ErrInvalidContract)
	}
	if !idPattern.MatchString(r.MatchID) {
		return fmt.Errorf("%w: runner request match id", ErrInvalidContract)
	}
	if r.Seat != SeatWhite && r.Seat != SeatBlack {
		return fmt.Errorf("%w: runner request seat", ErrInvalidContract)
	}
	if !runnerIDShape(r.RunnerID) {
		return fmt.Errorf("%w: runner request runner id", ErrInvalidContract)
	}
	if !idPattern.MatchString(r.LeaseID) {
		return fmt.Errorf("%w: runner request lease id", ErrInvalidContract)
	}
	if !runnerIDShape(r.RequestID) {
		return fmt.Errorf("%w: runner request id", ErrInvalidContract)
	}
	if r.ControlEpoch < 1 {
		return fmt.Errorf("%w: runner request control epoch", ErrInvalidContract)
	}
	if r.TurnVersion < 0 {
		return fmt.Errorf("%w: runner request turn version", ErrInvalidContract)
	}
	return nil
}

// runnerIDShape accepts an opaque runner or request identifier.
//
// The identifier never carries a credential, a route, or a conversation, so
// it stays a short opaque token.
func runnerIDShape(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// AcquireRunnerLease takes the runner lease of one seat.
//
// The lease is taken under the match row lock, so two runners cannot both
// believe they hold the seat. A runner that already holds the lease gets
// that lease back, so a retry after a lost acknowledgement never creates a
// second lease. A live lease of another runner is refused: a duplicate tab of
// the same owner shares the game instead of taking the seat.
func (s *Service) AcquireRunnerLease(ctx context.Context, actor ParticipantRef, req RunnerLeaseRequest) (RunnerLease, error) {
	if err := actor.Validate(); err != nil {
		return RunnerLease{}, ErrInvalidArgument
	}
	if err := req.Validate(); err != nil {
		return RunnerLease{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RunnerLease{}, err
	}
	defer tx.Rollback(ctx)
	match, _, decision, err := s.lockMatch(ctx, tx, req.MatchID)
	if err != nil {
		return RunnerLease{}, err
	}
	if err = s.authorizeCredential(ctx, tx, req.MatchID, actor); err != nil {
		return RunnerLease{}, err
	}
	seat, ok := match.Seat(req.Seat)
	if !ok || seat.Participant != actor {
		return RunnerLease{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, req.MatchID, actor, req.Seat); err != nil {
		return RunnerLease{}, err
	}
	// The shared gate refuses the lease while the service is suspended,
	// restoring or still recovering. A lease is a right to act for a seat,
	// and a service that is not serving cannot grant one.
	if err = s.requireGate(ctx, tx); err != nil {
		return RunnerLease{}, err
	}
	if match.Status != MatchActive {
		return RunnerLease{}, ErrMatchEnded
	}
	// A runner that did not see the latest control change is superseded. It
	// cannot take a lease for a seat it no longer controls.
	if req.ControlEpoch != match.ControlEpoch {
		return RunnerLease{}, ErrConflict
	}
	// A lease is bound to the turn it was taken for. A runner may only bind
	// the turn that is current now.
	turnVersion := req.TurnVersion
	if turnVersion == 0 {
		turnVersion = match.Version
	}
	if turnVersion != match.Version {
		return RunnerLease{}, ErrConflict
	}
	// A human seat has no browser runner. The lease of an agent seat is
	// released by the control change that hands the seat to a human.
	if seat.Control.Kind == ControlHuman {
		return RunnerLease{}, ErrActionNotAllowed
	}
	// An expired lease is not a live lease. It is closed first, so the
	// partial unique index on the live leases of a seat cannot block the new
	// one.
	if _, err = tx.Exec(ctx, `UPDATE online_runner_leases SET status='expired',revoked_at=$3,revoked_reason='expired' WHERE match_id=$1 AND seat=$2 AND status='active' AND expires_at <= $3`, req.MatchID, string(req.Seat), decision); err != nil {
		return RunnerLease{}, err
	}
	existing, err := loadActiveRunnerLease(ctx, tx, req.MatchID, req.Seat)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return RunnerLease{}, err
	}
	if err == nil {
		if existing.RunnerID != req.RunnerID {
			return RunnerLease{}, ErrConflict
		}
		// The same runner keeps its lease. The lease follows the current
		// turn, so a lease of an older turn never acts on a later one.
		if existing.TurnVersion == nil || *existing.TurnVersion != turnVersion {
			existing, err = s.rebindRunnerLease(ctx, tx, existing, turnVersion, decision)
			if err != nil {
				return RunnerLease{}, err
			}
		}
		if err = tx.Commit(ctx); err != nil {
			return RunnerLease{}, err
		}
		return existing, nil
	}
	lease, err := s.insertRunnerLease(ctx, tx, match, req, turnVersion, decision)
	if err != nil {
		return RunnerLease{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RunnerLease{}, err
	}
	return lease, nil
}

// RenewRunnerLease extends the liveness of a runner lease.
//
// A lease of an older control epoch, a lease of an older service epoch, a
// revoked lease, and a lease of another runner are all refused. The renewal
// never revives a fenced lease: the runner has to take a new one.
func (s *Service) RenewRunnerLease(ctx context.Context, actor ParticipantRef, req RunnerLeaseRequest) (RunnerLease, error) {
	if err := actor.Validate(); err != nil {
		return RunnerLease{}, ErrInvalidArgument
	}
	if err := req.Validate(); err != nil {
		return RunnerLease{}, err
	}
	if req.LeaseID == "" {
		return RunnerLease{}, ErrInvalidArgument
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RunnerLease{}, err
	}
	defer tx.Rollback(ctx)
	match, _, decision, err := s.lockMatch(ctx, tx, req.MatchID)
	if err != nil {
		return RunnerLease{}, err
	}
	if err = s.authorizeCredential(ctx, tx, req.MatchID, actor); err != nil {
		return RunnerLease{}, err
	}
	seat, ok := match.Seat(req.Seat)
	if !ok || seat.Participant != actor {
		return RunnerLease{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, req.MatchID, actor, req.Seat); err != nil {
		return RunnerLease{}, err
	}
	// The shared gate refuses the lease while the service is suspended,
	// restoring or still recovering. A lease is a right to act for a seat,
	// and a service that is not serving cannot grant one.
	if err = s.requireGate(ctx, tx); err != nil {
		return RunnerLease{}, err
	}
	lease, err := loadRunnerLease(ctx, tx, req.LeaseID)
	if err != nil {
		return RunnerLease{}, err
	}
	if lease.MatchID != req.MatchID || lease.Seat != req.Seat {
		return RunnerLease{}, ErrNotAuthorized
	}
	if lease.RunnerID != req.RunnerID {
		return RunnerLease{}, ErrNotAuthorized
	}
	if lease.Status != LeaseActive {
		return RunnerLease{}, ErrConflict
	}
	// A lease of a finished match is not renewed. The match is over, so the
	// lease ends with it instead of living on until it expires.
	if match.Status != MatchActive {
		if _, err = tx.Exec(ctx, `UPDATE online_runner_leases SET status='revoked',revoked_at=$1,revoked_reason=$2 WHERE lease_id=$3 AND status='active'`, decision, LeaseRevokeMatchEnded, req.LeaseID); err != nil {
			return RunnerLease{}, err
		}
		lease.Status = LeaseRevoked
		lease.RevokedAt = &decision
		reason := LeaseRevokeMatchEnded
		lease.RevokedReason = &reason
		if err = tx.Commit(ctx); err != nil {
			return RunnerLease{}, err
		}
		return lease, ErrMatchEnded
	}
	// An expired lease is never revived. It is closed here, so the lease
	// history shows that the runner lost the seat, and the runner has to
	// take a new one.
	if !lease.ExpiresAt.After(decision) {
		if _, err = tx.Exec(ctx, `UPDATE online_runner_leases SET status='expired',revoked_at=$2,revoked_reason='expired' WHERE lease_id=$1 AND status='active'`, req.LeaseID, decision); err != nil {
			return RunnerLease{}, err
		}
		return RunnerLease{}, ErrConflict
	}
	if lease.ControlEpoch != match.ControlEpoch || req.ControlEpoch != match.ControlEpoch {
		return RunnerLease{}, ErrConflict
	}
	epoch, err := currentServiceEpoch(ctx, tx)
	if err != nil {
		return RunnerLease{}, err
	}
	if lease.RunnerEpoch != epoch {
		return RunnerLease{}, ErrConflict
	}
	// The renewal binds the lease to the current turn. A lease of an older
	// turn never acts on a later one.
	turnVersion := req.TurnVersion
	if turnVersion == 0 {
		turnVersion = match.Version
	}
	if turnVersion != match.Version {
		return RunnerLease{}, ErrConflict
	}
	expires := decision.Add(RunnerLeaseTTL)
	if _, err = tx.Exec(ctx, `UPDATE online_runner_leases SET expires_at=$1,last_renewed_at=$2,turn_version=$3 WHERE lease_id=$4`, expires, decision, turnVersion, req.LeaseID); err != nil {
		return RunnerLease{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return RunnerLease{}, err
	}
	lease.ExpiresAt = expires
	lease.LastRenewedAt = &decision
	lease.TurnVersion = &turnVersion
	return lease, nil
}

// ReleaseRunnerLease gives the runner lease of one seat back.
//
// The release is the explicit human takeover path of the runner: the seat
// keeps its control, but no runner holds it any more, so a new runner can
// take it without waiting for the lease to expire.
func (s *Service) ReleaseRunnerLease(ctx context.Context, actor ParticipantRef, req RunnerLeaseRequest) (RunnerLease, error) {
	if err := actor.Validate(); err != nil {
		return RunnerLease{}, ErrInvalidArgument
	}
	if err := req.Validate(); err != nil {
		return RunnerLease{}, err
	}
	if req.LeaseID == "" {
		return RunnerLease{}, ErrInvalidArgument
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RunnerLease{}, err
	}
	defer tx.Rollback(ctx)
	match, _, decision, err := s.lockMatch(ctx, tx, req.MatchID)
	if err != nil {
		return RunnerLease{}, err
	}
	if err = s.authorizeCredential(ctx, tx, req.MatchID, actor); err != nil {
		return RunnerLease{}, err
	}
	seat, ok := match.Seat(req.Seat)
	if !ok || seat.Participant != actor {
		return RunnerLease{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, req.MatchID, actor, req.Seat); err != nil {
		return RunnerLease{}, err
	}
	// The shared gate refuses the lease while the service is suspended,
	// restoring or still recovering. A lease is a right to act for a seat,
	// and a service that is not serving cannot grant one.
	if err = s.requireGate(ctx, tx); err != nil {
		return RunnerLease{}, err
	}
	lease, err := loadRunnerLease(ctx, tx, req.LeaseID)
	if err != nil {
		return RunnerLease{}, err
	}
	if lease.MatchID != req.MatchID || lease.Seat != req.Seat {
		return RunnerLease{}, ErrNotAuthorized
	}
	if lease.RunnerID != req.RunnerID {
		return RunnerLease{}, ErrNotAuthorized
	}
	if lease.Status == LeaseActive {
		if _, err = tx.Exec(ctx, `UPDATE online_runner_leases SET status='revoked',revoked_at=$1,revoked_reason=$2 WHERE lease_id=$3 AND status='active'`, decision, LeaseRevokeReleased, req.LeaseID); err != nil {
			return RunnerLease{}, err
		}
		lease.Status = LeaseRevoked
		lease.RevokedAt = &decision
		reason := LeaseRevokeReleased
		lease.RevokedReason = &reason
	}
	if err = tx.Commit(ctx); err != nil {
		return RunnerLease{}, err
	}
	return lease, nil
}

// GetSeatRunnerLease returns the lease of one seat to a participant of its
// match.
//
// A seat without a lease is not an error for the caller: the reader reports
// that no runner holds the seat.
func (s *Service) GetSeatRunnerLease(ctx context.Context, actor ParticipantRef, matchID string, seat Seat) (RunnerLease, error) {
	if err := actor.Validate(); err != nil {
		return RunnerLease{}, ErrInvalidArgument
	}
	if !idPattern.MatchString(matchID) {
		return RunnerLease{}, ErrInvalidArgument
	}
	if seat != SeatWhite && seat != SeatBlack {
		return RunnerLease{}, ErrInvalidArgument
	}
	var lease RunnerLease
	_, err := loadMatchSnapshot(ctx, s.db, matchID, func(ctx context.Context, tx pgx.Tx, match Match) error {
		if err := s.authorizeCredential(ctx, tx, matchID, actor); err != nil {
			return err
		}
		if !match.HasParticipant(actor) {
			return ErrNotFound
		}
		// A lease names the runner of a seat and the provider request it may
		// have started. It is the identity of one browser, so it is only
		// readable by the participant that owns the seat.
		own, ok := match.Seat(actorSeat(match, actor))
		if !ok || own.Seat != seat {
			return ErrNotAuthorized
		}
		found, err := loadLatestRunnerLease(ctx, tx, matchID, seat)
		if err != nil {
			return err
		}
		lease = found
		return nil
	})
	if err != nil {
		return RunnerLease{}, err
	}
	return lease, nil
}

// BeginRunnerRequest records that a billable provider request started.
//
// The record is what makes an uncertain request honest: a runner that is lost
// while the request may still be running leaves the identifier behind, and
// the next runner offers an explicit Retry, switch, or takeover instead of
// issuing another provider request.
func (s *Service) BeginRunnerRequest(ctx context.Context, actor ParticipantRef, req RunnerRequestRequest) (RunnerLease, error) {
	return s.writeRunnerRequest(ctx, actor, req, true)
}

// ClearRunnerRequest records that the provider request settled.
func (s *Service) ClearRunnerRequest(ctx context.Context, actor ParticipantRef, req RunnerRequestRequest) (RunnerLease, error) {
	return s.writeRunnerRequest(ctx, actor, req, false)
}

func (s *Service) writeRunnerRequest(ctx context.Context, actor ParticipantRef, req RunnerRequestRequest, begin bool) (RunnerLease, error) {
	if err := actor.Validate(); err != nil {
		return RunnerLease{}, ErrInvalidArgument
	}
	if err := req.Validate(); err != nil {
		return RunnerLease{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return RunnerLease{}, err
	}
	defer tx.Rollback(ctx)
	match, _, decision, err := s.lockMatch(ctx, tx, req.MatchID)
	if err != nil {
		return RunnerLease{}, err
	}
	if err = s.authorizeCredential(ctx, tx, req.MatchID, actor); err != nil {
		return RunnerLease{}, err
	}
	seat, ok := match.Seat(req.Seat)
	if !ok || seat.Participant != actor {
		return RunnerLease{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, req.MatchID, actor, req.Seat); err != nil {
		return RunnerLease{}, err
	}
	// The shared gate refuses the lease while the service is suspended,
	// restoring or still recovering. A lease is a right to act for a seat,
	// and a service that is not serving cannot grant one.
	if err = s.requireGate(ctx, tx); err != nil {
		return RunnerLease{}, err
	}
	lease, err := loadRunnerLease(ctx, tx, req.LeaseID)
	if err != nil {
		return RunnerLease{}, err
	}
	if lease.MatchID != req.MatchID || lease.Seat != req.Seat {
		return RunnerLease{}, ErrNotAuthorized
	}
	if lease.RunnerID != req.RunnerID {
		return RunnerLease{}, ErrNotAuthorized
	}
	if lease.Status != LeaseActive {
		return RunnerLease{}, ErrConflict
	}
	// An expired lease cannot record a request either: the runner lost the
	// seat, so its request record is no longer authoritative.
	if !lease.ExpiresAt.After(decision) {
		return RunnerLease{}, ErrConflict
	}
	// A finished match records no provider request. The work of the match is
	// over, so a billable request must not start or settle against it.
	if match.Status != MatchActive {
		return RunnerLease{}, ErrMatchEnded
	}
	if lease.ControlEpoch != match.ControlEpoch || req.ControlEpoch != match.ControlEpoch {
		return RunnerLease{}, ErrConflict
	}
	epoch, err := currentServiceEpoch(ctx, tx)
	if err != nil {
		return RunnerLease{}, err
	}
	if lease.RunnerEpoch != epoch {
		return RunnerLease{}, ErrConflict
	}
	// The request belongs to the turn the lease is bound to.
	turnVersion := req.TurnVersion
	if turnVersion == 0 {
		turnVersion = match.Version
	}
	if turnVersion != match.Version || lease.TurnVersion == nil || *lease.TurnVersion != turnVersion {
		return RunnerLease{}, ErrConflict
	}
	if begin {
		if lease.PendingRequestID != nil && *lease.PendingRequestID != req.RequestID {
			// Another request is still recorded. The runner has to settle
			// it before it starts another one.
			return RunnerLease{}, ErrConflict
		}
		if _, err = tx.Exec(ctx, `UPDATE online_runner_leases SET pending_request_id=$1,pending_request_started_at=$2 WHERE lease_id=$3`, req.RequestID, decision, req.LeaseID); err != nil {
			return RunnerLease{}, err
		}
		lease.PendingRequestID = &req.RequestID
		lease.PendingRequestStartedAt = &decision
	} else {
		if lease.PendingRequestID != nil && *lease.PendingRequestID != req.RequestID {
			return RunnerLease{}, ErrConflict
		}
		if _, err = tx.Exec(ctx, `UPDATE online_runner_leases SET pending_request_id=NULL,pending_request_started_at=NULL WHERE lease_id=$1`, req.LeaseID); err != nil {
			return RunnerLease{}, err
		}
		lease.PendingRequestID = nil
		lease.PendingRequestStartedAt = nil
	}
	if err = tx.Commit(ctx); err != nil {
		return RunnerLease{}, err
	}
	return lease, nil
}

// revokeSeatRunnerLease closes the live lease of one seat.
//
// A control change and a finished match both revoke the lease of the seat, so
// the old runner is fenced at once instead of waiting for its lease to
// expire.
func revokeSeatRunnerLease(ctx context.Context, tx pgx.Tx, matchID string, seat Seat, at time.Time, reason string) error {
	_, err := tx.Exec(ctx, `UPDATE online_runner_leases SET status='revoked',revoked_at=$1,revoked_reason=$2 WHERE match_id=$3 AND seat=$4 AND status='active'`, at.UTC(), reason, matchID, string(seat))
	return err
}

// insertRunnerLease writes a new lease of one seat.
//
// The uncertain provider request of the previous lease of that seat survives
// the lease change. A new runner therefore sees that the previous runner may
// have started billable work, and it offers an explicit Retry, switch, or
// takeover instead of issuing another provider request.
func (s *Service) insertRunnerLease(ctx context.Context, tx pgx.Tx, match Match, req RunnerLeaseRequest, turnVersion int64, decision time.Time) (RunnerLease, error) {
	leaseID, err := newRunnerLeaseID()
	if err != nil {
		return RunnerLease{}, err
	}
	var generation int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE(MAX(generation),0)+1 FROM online_runner_leases WHERE match_id=$1 AND seat=$2`, req.MatchID, string(req.Seat)).Scan(&generation); err != nil {
		return RunnerLease{}, err
	}
	epoch, err := currentServiceEpoch(ctx, tx)
	if err != nil {
		return RunnerLease{}, err
	}
	// The uncertain request of the previous lease is carried over.
	var pendingID *string
	var pendingAt *time.Time
	previous, err := loadLatestRunnerLease(ctx, tx, req.MatchID, req.Seat)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return RunnerLease{}, err
	}
	if err == nil && previous.PendingRequestID != nil {
		pendingID = previous.PendingRequestID
		pendingAt = previous.PendingRequestStartedAt
	}
	expires := decision.Add(RunnerLeaseTTL)
	if _, err = tx.Exec(ctx, `INSERT INTO online_runner_leases(lease_id,match_id,seat,control_epoch,generation,runner_id,status,acquired_at,expires_at,turn_version,runner_epoch,last_renewed_at,pending_request_id,pending_request_started_at) VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$7,$11,$12)`,
		leaseID, req.MatchID, string(req.Seat), match.ControlEpoch, generation, req.RunnerID, decision, expires, turnVersion, epoch, pendingID, pendingAt); err != nil {
		return RunnerLease{}, err
	}
	return RunnerLease{
		SchemaVersion:           ContractsSchemaVersion,
		LeaseID:                 leaseID,
		MatchID:                 req.MatchID,
		Seat:                    req.Seat,
		ControlEpoch:            match.ControlEpoch,
		Generation:              generation,
		RunnerID:                req.RunnerID,
		Status:                  LeaseActive,
		AcquiredAt:              decision,
		ExpiresAt:               expires,
		TurnVersion:             &turnVersion,
		RunnerEpoch:             epoch,
		LastRenewedAt:           &decision,
		PendingRequestID:        pendingID,
		PendingRequestStartedAt: pendingAt,
	}, nil
}

// rebindRunnerLease moves a live lease to the turn the runner acts for.
func (s *Service) rebindRunnerLease(ctx context.Context, tx pgx.Tx, lease RunnerLease, turnVersion int64, decision time.Time) (RunnerLease, error) {
	if _, err := tx.Exec(ctx, `UPDATE online_runner_leases SET turn_version=$1,last_renewed_at=$2 WHERE lease_id=$3`, turnVersion, decision, lease.LeaseID); err != nil {
		return RunnerLease{}, err
	}
	lease.TurnVersion = &turnVersion
	lease.LastRenewedAt = &decision
	return lease, nil
}

// loadRunnerLease reads one lease.
func loadRunnerLease(ctx context.Context, q queryer, leaseID string) (RunnerLease, error) {
	var lease RunnerLease
	var status string
	err := q.QueryRow(ctx, `SELECT lease_id,match_id,seat,control_epoch,generation,runner_id,status,acquired_at,expires_at,revoked_at,turn_version,runner_epoch,pending_request_id,pending_request_started_at,revoked_reason,last_renewed_at FROM online_runner_leases WHERE lease_id=$1`, leaseID).
		Scan(&lease.LeaseID, &lease.MatchID, &lease.Seat, &lease.ControlEpoch, &lease.Generation, &lease.RunnerID, &status, &lease.AcquiredAt, &lease.ExpiresAt, &lease.RevokedAt, &lease.TurnVersion, &lease.RunnerEpoch, &lease.PendingRequestID, &lease.PendingRequestStartedAt, &lease.RevokedReason, &lease.LastRenewedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return RunnerLease{}, ErrNotFound
	}
	if err != nil {
		return RunnerLease{}, err
	}
	lease.SchemaVersion = ContractsSchemaVersion
	lease.Status = LeaseStatus(status)
	lease.AcquiredAt = lease.AcquiredAt.UTC()
	lease.ExpiresAt = lease.ExpiresAt.UTC()
	if lease.RevokedAt != nil {
		value := lease.RevokedAt.UTC()
		lease.RevokedAt = &value
	}
	if lease.PendingRequestStartedAt != nil {
		value := lease.PendingRequestStartedAt.UTC()
		lease.PendingRequestStartedAt = &value
	}
	if lease.LastRenewedAt != nil {
		value := lease.LastRenewedAt.UTC()
		lease.LastRenewedAt = &value
	}
	return lease, nil
}

// loadActiveRunnerLease reads the live lease of one seat.
func loadActiveRunnerLease(ctx context.Context, q queryer, matchID string, seat Seat) (RunnerLease, error) {
	var leaseID string
	err := q.QueryRow(ctx, `SELECT lease_id FROM online_runner_leases WHERE match_id=$1 AND seat=$2 AND status='active'`, matchID, string(seat)).Scan(&leaseID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RunnerLease{}, ErrNotFound
	}
	if err != nil {
		return RunnerLease{}, err
	}
	return loadRunnerLease(ctx, q, leaseID)
}

// loadLatestRunnerLease reads the newest lease of one seat.
func loadLatestRunnerLease(ctx context.Context, q queryer, matchID string, seat Seat) (RunnerLease, error) {
	var leaseID string
	err := q.QueryRow(ctx, `SELECT lease_id FROM online_runner_leases WHERE match_id=$1 AND seat=$2 ORDER BY generation DESC LIMIT 1`, matchID, string(seat)).Scan(&leaseID)
	if errors.Is(err, pgx.ErrNoRows) {
		return RunnerLease{}, ErrNotFound
	}
	if err != nil {
		return RunnerLease{}, err
	}
	return loadRunnerLease(ctx, q, leaseID)
}

// authorizePresentedLease fences a command that presents a runner lease.
//
// A lease is a right to act for a seat, so a command that carries one may
// only act while the lease is live: it must be active, it must not have
// expired, it must belong to the current control epoch and to the current
// service epoch, and it must be bound to the turn the command acts for.
//
// The check applies to every action, not only to the move. A stale runner
// may not resign, spend a recovery attempt, or change the control of its
// seat, because those actions end the game as surely as a move does.
//
// A command that presents no lease is the owner acting for itself. That
// stays allowed, so an owner may always resign or cancel, and a seat that a
// human controls never needs a lease.
func (s *Service) authorizePresentedLease(ctx context.Context, tx pgx.Tx, match Match, cmd Command, decision time.Time) error {
	if cmd.LeaseID == "" {
		return nil
	}
	lease, err := loadRunnerLease(ctx, tx, cmd.LeaseID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return ErrNotAuthorized
		}
		return err
	}
	if lease.MatchID != match.MatchID || lease.Seat != cmd.Seat {
		return ErrNotAuthorized
	}
	if lease.Status != LeaseActive {
		return ErrNotAuthorized
	}
	// The liveness of the lease is judged against the authoritative time of
	// the acceptance transaction, so an expired lease cannot act even when
	// no other runner has taken the seat yet.
	if !lease.ExpiresAt.After(decision) {
		return ErrNotAuthorized
	}
	if lease.ControlEpoch != match.ControlEpoch {
		return ErrNotAuthorized
	}
	epoch, err := currentServiceEpoch(ctx, tx)
	if err != nil {
		return err
	}
	if lease.RunnerEpoch != epoch {
		return ErrNotAuthorized
	}
	// The lease is bound to the turn the command acts for. A lease of an
	// older turn cannot act for a later one.
	if lease.TurnVersion == nil || *lease.TurnVersion != cmd.ExpectedVersion {
		return ErrNotAuthorized
	}
	return nil
}

// authorizeRunnerLease fences a command that arrives without the current
// runner lease of an agent seat.
//
// The check runs inside the acceptance transaction, after the match row lock
// is held, and it reads the authoritative decision time of that transaction.
// A lease that expired, that was revoked, that belongs to an older control
// epoch, that belongs to an older service epoch, or that is bound to another
// turn cannot be used to accept a move. A human seat needs no lease, but a
// lease that is presented is still checked.
func (s *Service) authorizeRunnerLease(ctx context.Context, tx pgx.Tx, match Match, cmd Command, decision time.Time) error {
	seat, ok := match.Seat(cmd.Seat)
	if !ok {
		return ErrNotAuthorized
	}
	if cmd.LeaseID == "" {
		if seat.Control.Kind == ControlHuman {
			return nil
		}
		// An agent seat acts through a browser runner, and the runner
		// holds the lease of the seat.
		return ErrNotAuthorized
	}
	return s.authorizePresentedLease(ctx, tx, match, cmd, decision)
}

// newRunnerLeaseID mints an opaque lease identifier.
func newRunnerLeaseID() (string, error) {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return "lease-" + hex.EncodeToString(raw), nil
}

// currentServiceEpoch reads the current service epoch.
//
// The epoch advances once per detected interruption, never on every process
// start, so an instance that merely joins does not invalidate the leases of
// its peers.
func currentServiceEpoch(ctx context.Context, q queryer) (int64, error) {
	var epoch int64
	if err := q.QueryRow(ctx, `SELECT COALESCE(MAX(epoch),1) FROM online_service_epochs`).Scan(&epoch); err != nil {
		return 0, err
	}
	return epoch, nil
}

// ServiceEpoch returns the current service epoch.
func (s *Service) ServiceEpoch(ctx context.Context) (int64, error) {
	return currentServiceEpoch(ctx, s.db)
}
