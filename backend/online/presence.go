package online

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// The online presence and the optional abandonment claim.
//
// Presence is a liveness record. A browser reports in with an application
// heartbeat every five seconds, and each heartbeat buys a fifteen second
// liveness lease. A responsive background tab keeps heartbeating and stays
// eligible. A suspended client stops heartbeating, its lease expires, and the
// participant counts as offline from that moment.
//
// A connected opponent may use the whole chess clock. Only after both sides
// have moved and the opponent has been continuously offline for one full
// minute does the other participant get the optional "Claim win" action.
// "Keep waiting" preserves that option and never concedes anything.
//
// A service outage is not opponent abandonment. The claim consumes the
// durable service health boundary, so a failing rules service can never be
// read as an absent opponent.

// The presence cadence and the liveness lease.
const (
	// PresenceHeartbeatInterval is the application heartbeat cadence.
	PresenceHeartbeatInterval = 5 * time.Second
	// PresenceLeaseTTL is the liveness lease one heartbeat buys.
	PresenceLeaseTTL = 15 * time.Second
	// AbandonmentGracePeriod is the continuous offline interval that enables
	// the optional claim. It starts when the liveness lease expires, so a
	// participant is never claimed against while its lease still holds.
	AbandonmentGracePeriod = 60 * time.Second
)

// PresenceState is the observed liveness of one seat.
type PresenceState string

const (
	// PresenceConnected means the liveness lease still holds.
	PresenceConnected PresenceState = "connected"
	// PresenceOffline means the liveness lease expired.
	PresenceOffline PresenceState = "offline"
	// PresenceUnknown means the seat never reported in.
	PresenceUnknown PresenceState = "unknown"
)

// The reasons a claim is or is not available. They are stable, allowlisted
// strings, so a client can render a state without parsing prose.
const (
	// ClaimReasonEligible means the claim may be made.
	ClaimReasonEligible = "eligible"
	// ClaimReasonOpponentConnected means the opponent is connected and may
	// use the whole clock.
	ClaimReasonOpponentConnected = "opponent-connected"
	// ClaimReasonOpponentUnknown means the opponent never reported in, so no
	// offline interval can be measured.
	ClaimReasonOpponentUnknown = "opponent-unknown"
	// ClaimReasonAwaitingMoves means not both sides have moved yet.
	ClaimReasonAwaitingMoves = "awaiting-first-moves"
	// ClaimReasonOpeningReply means the opening reply window is still open.
	// A claim never bypasses the opening abort rules.
	ClaimReasonOpeningReply = "opening-reply-outstanding"
	// ClaimReasonServiceUnavailable means the service itself is not healthy,
	// so an absence is not evidence of an absent opponent.
	ClaimReasonServiceUnavailable = "service-unavailable"
	// ClaimReasonMatchEnded means the match already has a final result.
	ClaimReasonMatchEnded = "match-ended"
	// ClaimReasonGracePeriod means the opponent is offline but the continuous
	// offline minute has not elapsed yet.
	ClaimReasonGracePeriod = "offline-grace-period"
)

// SeatPresence is the allowlisted presence of one seat.
//
// It carries no participant reference, no credential, and no session
// identifier. The seat identity and the state are all a client needs.
type SeatPresence struct {
	// Seat is the seat this presence describes.
	Seat Seat `json:"seat"`
	// State is the observed liveness.
	State PresenceState `json:"state"`
	// LastHeartbeatAt is when the participant last reported in.
	LastHeartbeatAt *time.Time `json:"lastHeartbeatAt"`
	// LeaseExpiresAt is the end of the liveness lease.
	LeaseExpiresAt *time.Time `json:"leaseExpiresAt"`
	// OfflineSince is the moment the participant counts as offline. It is
	// the end of the liveness lease, so a fresh heartbeat starts a fresh
	// offline interval.
	OfflineSince *time.Time `json:"offlineSince"`
	// KeepWaitingAt is when the other participant chose to keep waiting for
	// this seat. It describes the offline interval of this seat, so a
	// heartbeat of the waiting participant never clears it and the
	// reconnect of this seat does.
	KeepWaitingAt *time.Time `json:"keepWaitingAt"`
}

// ClaimAvailability describes whether the requesting participant may claim a
// win because the opponent is offline.
type ClaimAvailability struct {
	// Eligible reports whether the claim may be made now.
	Eligible bool `json:"eligible"`
	// Reason is the stable reason code.
	Reason string `json:"reason"`
	// OpponentSeat is the seat that would be claimed against.
	OpponentSeat *Seat `json:"opponentSeat"`
	// OfflineSince is when the opponent became offline.
	OfflineSince *time.Time `json:"offlineSince"`
	// GraceSecondsLeft is how much of the continuous offline minute is
	// still missing. It is zero when the claim is already available.
	GraceSecondsLeft int64 `json:"graceSecondsLeft"`
	// WaitingSince is when the participant chose to keep waiting for the
	// opponent. The claim stays available while it waits.
	WaitingSince *time.Time `json:"waitingSince"`
}

// PresenceView is the allowlisted presence view of one match.
//
// It never carries a participant reference, an owner identifier, a session
// identifier, a credential, a token, or a hash.
type PresenceView struct {
	// SchemaVersion is the contract version of this view.
	SchemaVersion int `json:"schemaVersion"`
	// MatchID is the match this view describes.
	MatchID string `json:"matchId"`
	// Version is the canonical match version the view was read at.
	Version int64 `json:"version"`
	// ControlEpoch is the canonical control epoch the view was read at.
	ControlEpoch int64 `json:"controlEpoch"`
	// Status is the canonical match status.
	Status MatchStatus `json:"status"`
	// Seats holds the presence of both seats.
	Seats []SeatPresence `json:"seats"`
	// ServiceState is the durable health of the service. A client never
	// offers the claim while it is not healthy.
	ServiceState HealthState `json:"serviceState"`
	// Recovered reports whether the canonical recovery of an interrupted
	// service has completed. A client shows the recovering state while it
	// is false.
	Recovered bool `json:"recovered"`
	// Claim describes the claim option of the requesting participant.
	Claim ClaimAvailability `json:"claim"`
	// YourSeat is the seat of the requesting participant.
	YourSeat *Seat `json:"yourSeat"`
}

// ClaimCommand is the command envelope of an abandonment claim.
//
// It is a closed, typed envelope like the match command, but it is not a
// match action: a claim never changes the position, the turn, or the clocks
// of a running game, so it does not belong to the shared action union.
type ClaimCommand struct {
	SchemaVersion   int    `json:"schemaVersion"`
	MatchID         string `json:"matchId"`
	OperationID     string `json:"operationId"`
	ExpectedVersion int64  `json:"expectedVersion"`
	Seat            Seat   `json:"seat"`
	ControlEpoch    int64  `json:"controlEpoch"`
}

// ParseClaimCommand decodes a strict claim envelope. Unknown fields, trailing
// data, and contract violations are rejected.
func ParseClaimCommand(raw []byte) (ClaimCommand, error) {
	var cmd ClaimCommand
	if err := decodeStrict(raw, &cmd); err != nil {
		return ClaimCommand{}, fmt.Errorf("%w: claim envelope: %v", ErrInvalidContract, err)
	}
	if err := cmd.Validate(); err != nil {
		return ClaimCommand{}, err
	}
	return cmd, nil
}

// Validate checks the claim envelope.
func (c ClaimCommand) Validate() error {
	if c.SchemaVersion != ContractsSchemaVersion {
		return fmt.Errorf("%w: claim schema version", ErrInvalidContract)
	}
	if !idPattern.MatchString(c.MatchID) || !idPattern.MatchString(c.OperationID) {
		return fmt.Errorf("%w: claim match or operation id", ErrInvalidContract)
	}
	if c.ExpectedVersion < 1 {
		return fmt.Errorf("%w: claim expected version", ErrInvalidContract)
	}
	if c.Seat != SeatWhite && c.Seat != SeatBlack {
		return fmt.Errorf("%w: claim seat", ErrInvalidContract)
	}
	if c.ControlEpoch < 1 {
		return fmt.Errorf("%w: claim control epoch", ErrInvalidContract)
	}
	return nil
}

// ClaimInputs are the facts the claim decision reads. They are gathered under
// the match row lock, so they describe one committed state.
type ClaimInputs struct {
	// MatchStatus is the canonical match status.
	MatchStatus MatchStatus
	// WhiteMoved and BlackMoved record that both sides moved.
	WhiteMoved bool
	BlackMoved bool
	// ReplyOutstanding reports that the opening reply window is still open.
	ReplyOutstanding bool
	// Opponent is the presence of the seat that would be claimed against.
	Opponent SeatPresence
	// Now is the authoritative decision time.
	Now time.Time
	// ServiceState is the durable health of the service.
	ServiceState HealthState
}

// EvaluateClaim decides whether the optional abandonment claim is available.
//
// The order of the checks is part of the contract:
//
//   - A finished match is never claimable, because an earlier terminal
//     outcome stays final.
//   - A service that is not healthy never offers the claim, so a service
//     outage cannot masquerade as opponent absence.
//   - An open opening reply window never offers the claim, so the claim
//     cannot bypass the opening abort rules.
//   - A participant that has not moved yet never offers the claim, because
//     the claim exists only after both sides moved.
//   - A connected opponent never offers the claim, so a connected opponent
//     may use the whole clock.
//   - An opponent that never reported in never offers the claim, because no
//     continuous offline interval can be measured.
func EvaluateClaim(in ClaimInputs) ClaimAvailability {
	opponent := in.Opponent.Seat
	if in.MatchStatus != MatchActive {
		return ClaimAvailability{Reason: ClaimReasonMatchEnded, OpponentSeat: &opponent}
	}
	if !in.ServiceState.Valid() || !in.ServiceState.ClaimsAllowed() {
		return ClaimAvailability{Reason: ClaimReasonServiceUnavailable, OpponentSeat: &opponent}
	}
	if in.ReplyOutstanding {
		return ClaimAvailability{Reason: ClaimReasonOpeningReply, OpponentSeat: &opponent}
	}
	if !in.WhiteMoved || !in.BlackMoved {
		return ClaimAvailability{Reason: ClaimReasonAwaitingMoves, OpponentSeat: &opponent}
	}
	switch in.Opponent.State {
	case PresenceConnected:
		return ClaimAvailability{Reason: ClaimReasonOpponentConnected, OpponentSeat: &opponent}
	case PresenceUnknown:
		return ClaimAvailability{Reason: ClaimReasonOpponentUnknown, OpponentSeat: &opponent}
	}
	if in.Opponent.OfflineSince == nil {
		return ClaimAvailability{Reason: ClaimReasonOpponentUnknown, OpponentSeat: &opponent}
	}
	elapsed := in.Now.Sub(*in.Opponent.OfflineSince)
	if elapsed < AbandonmentGracePeriod {
		remaining := AbandonmentGracePeriod - elapsed
		seconds := int64((remaining + time.Second - 1) / time.Second)
		return ClaimAvailability{
			Reason:           ClaimReasonGracePeriod,
			OpponentSeat:     &opponent,
			OfflineSince:     in.Opponent.OfflineSince,
			GraceSecondsLeft: seconds,
		}
	}
	return ClaimAvailability{
		Eligible:     true,
		Reason:       ClaimReasonEligible,
		OpponentSeat: &opponent,
		OfflineSince: in.Opponent.OfflineSince,
	}
}

// Heartbeat records one application heartbeat and extends the liveness lease.
//
// The heartbeat is the only way a participant becomes connected. It is
// idempotent in the sense that a repeated heartbeat only moves the lease
// forward: it never creates a second presence record and never changes the
// match state.
func (s *Service) Heartbeat(ctx context.Context, actor ParticipantRef, matchID string, seat Seat) (SeatPresence, error) {
	if err := actor.Validate(); err != nil {
		return SeatPresence{}, ErrInvalidArgument
	}
	if !idPattern.MatchString(matchID) {
		return SeatPresence{}, ErrInvalidArgument
	}
	if seat != SeatWhite && seat != SeatBlack {
		return SeatPresence{}, ErrInvalidArgument
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return SeatPresence{}, err
	}
	defer tx.Rollback(ctx)
	// The match row is shared-locked for the whole heartbeat, so the claim
	// path, which needs the match row exclusively, is ordered against it. A
	// heartbeat that is accepted first clears the claim eligibility of the
	// opponent.
	match, err := loadMatchForShare(ctx, tx, matchID)
	if err != nil {
		return SeatPresence{}, err
	}
	if err = s.authorizeCredential(ctx, tx, matchID, actor); err != nil {
		return SeatPresence{}, err
	}
	owner, ok := match.Seat(seat)
	if !ok || owner.Participant != actor {
		return SeatPresence{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, matchID, actor, seat); err != nil {
		return SeatPresence{}, err
	}
	decision, err := s.sampleDecision(ctx, tx, match.UpdatedAt)
	if err != nil {
		return SeatPresence{}, err
	}
	presence, err := s.upsertHeartbeat(ctx, tx, matchID, seat, actor, decision)
	if err != nil {
		return SeatPresence{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return SeatPresence{}, err
	}
	return presence, nil
}

// KeepWaiting records that the participant chose to wait instead of claiming
// the win.
//
// The option is preserved: the claim stays available, and the normal clock
// behaviour is untouched. The choice is scoped to the current offline
// interval, because the next heartbeat clears it.
func (s *Service) KeepWaiting(ctx context.Context, actor ParticipantRef, matchID string, seat Seat) (SeatPresence, error) {
	if err := actor.Validate(); err != nil {
		return SeatPresence{}, ErrInvalidArgument
	}
	if !idPattern.MatchString(matchID) {
		return SeatPresence{}, ErrInvalidArgument
	}
	if seat != SeatWhite && seat != SeatBlack {
		return SeatPresence{}, ErrInvalidArgument
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return SeatPresence{}, err
	}
	defer tx.Rollback(ctx)
	match, err := loadMatchForShare(ctx, tx, matchID)
	if err != nil {
		return SeatPresence{}, err
	}
	if err = s.authorizeCredential(ctx, tx, matchID, actor); err != nil {
		return SeatPresence{}, err
	}
	owner, ok := match.Seat(seat)
	if !ok || owner.Participant != actor {
		return SeatPresence{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, matchID, actor, seat); err != nil {
		return SeatPresence{}, err
	}
	decision, err := s.sampleDecision(ctx, tx, match.UpdatedAt)
	if err != nil {
		return SeatPresence{}, err
	}
	presence, err := s.markKeepWaiting(ctx, tx, matchID, seat, actor, decision)
	if err != nil {
		return SeatPresence{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return SeatPresence{}, err
	}
	return presence, nil
}

// GetPresence returns the presence view of one match to one of its
// participants.
//
// A missing match and a match the caller does not belong to share
// ErrNotFound, so the view never leaks the existence of a match.
func (s *Service) GetPresence(ctx context.Context, actor ParticipantRef, matchID string) (PresenceView, error) {
	if err := actor.Validate(); err != nil {
		return PresenceView{}, ErrInvalidArgument
	}
	if !idPattern.MatchString(matchID) {
		return PresenceView{}, ErrInvalidArgument
	}
	var view PresenceView
	_, err := loadMatchSnapshot(ctx, s.db, matchID, func(ctx context.Context, tx pgx.Tx, match Match) error {
		if err := s.authorizeCredential(ctx, tx, matchID, actor); err != nil {
			return err
		}
		if !match.HasParticipant(actor) {
			return ErrNotFound
		}
		decision, err := s.sampleDecision(ctx, tx, match.UpdatedAt)
		if err != nil {
			return err
		}
		seats, err := loadPresence(ctx, tx, matchID, decision)
		if err != nil {
			return err
		}
		yourSeat, ok := match.Seat(actorSeat(match, actor))
		view = PresenceView{
			SchemaVersion: ContractsSchemaVersion,
			MatchID:       matchID,
			Version:       match.Version,
			ControlEpoch:  match.ControlEpoch,
			Status:        match.Status,
			Seats:         seats,
			ServiceState:  s.healthState(ctx),
			Recovered:     s.Recovered(),
		}
		if !ok {
			return ErrNotFound
		}
		own := yourSeat.Seat
		view.YourSeat = &own
		opponent, ok := own.Other()
		if !ok {
			return ErrInvalidContract
		}
		opponentPresence := SeatPresence{Seat: opponent, State: PresenceUnknown}
		for _, presence := range seats {
			if presence.Seat == opponent {
				opponentPresence = presence
			}
		}
		view.Claim = EvaluateClaim(ClaimInputs{
			MatchStatus:      match.Status,
			WhiteMoved:       match.Clock.WhiteMoved,
			BlackMoved:       match.Clock.BlackMoved,
			ReplyOutstanding: match.Clock.AwaitingOpeningReply(),
			Opponent:         opponentPresence,
			Now:              decision,
			ServiceState:     view.ServiceState,
		})
		// The waiting choice belongs to the offline interval of the
		// opponent, so the marker sits on the opponent's presence record.
		view.Claim.WaitingSince = opponentPresence.KeepWaitingAt
		return nil
	})
	if err != nil {
		return PresenceView{}, err
	}
	return view, nil
}

// ClaimAbandonment ends a match with an optional abandonment win.
//
// The claim is serialized against the reconnect, the clock expiry, and every
// other terminal outcome: it takes the match row lock, re-checks the
// canonical version, the control epoch, the presence of the opponent, and
// the health of the service, and only then commits the result. A reconnect
// that was accepted first clears the eligibility, and a result that was
// accepted first stays final.
func (s *Service) ClaimAbandonment(ctx context.Context, actor ParticipantRef, cmd ClaimCommand) (CommandResult, error) {
	if err := actor.Validate(); err != nil {
		return CommandResult{}, ErrInvalidArgument
	}
	if err := cmd.Validate(); err != nil {
		return CommandResult{}, err
	}
	// The canonical state of an interrupted service is published before a
	// resumed action is accepted, and a claim finalizes a match. A claim
	// therefore waits for the recovery exactly like a command does.
	if s.recoveryRequired.Load() && !s.recovered.Load() {
		return CommandResult{}, ErrUnavailable
	}
	fingerprint, err := claimFingerprint(actor, cmd)
	if err != nil {
		return CommandResult{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return CommandResult{}, err
	}
	defer tx.Rollback(ctx)
	match, clock, _, err := s.lockMatch(ctx, tx, cmd.MatchID)
	if err != nil {
		return CommandResult{}, err
	}
	if err = s.authorizeCredential(ctx, tx, cmd.MatchID, actor); err != nil {
		return CommandResult{}, err
	}
	if duplicate, err := loadReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:]); err == nil {
		return duplicate, nil
	} else if !errors.Is(err, ErrNotFound) {
		return CommandResult{}, err
	}
	match.Clock = clock
	seat, ok := match.Seat(cmd.Seat)
	if !ok || seat.Participant != actor {
		return CommandResult{}, ErrNotAuthorized
	}
	if err = s.authorizeSeat(ctx, tx, cmd.MatchID, actor, cmd.Seat); err != nil {
		return CommandResult{}, err
	}
	if match.Moves, err = loadMoves(ctx, tx, cmd.MatchID); err != nil {
		return CommandResult{}, err
	}
	decision, err := s.sampleDecision(ctx, tx, match.UpdatedAt)
	if err != nil {
		return CommandResult{}, err
	}
	// The opening reply window is reconciled before any other deadline, so a
	// claim never bypasses the opening abort rules.
	if clock.ReplyExpired(decision) && match.Status == MatchActive {
		return s.commitOpeningAbort(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint, match, clock, decision)
	}
	if clock.IsExpired(decision) && match.Status == MatchActive {
		_ = tx.Rollback(ctx)
		return s.resolveExpiredMatch(ctx, actor, cmd.MatchID, cmd.OperationID, cmd.Seat, fingerprint, match)
	}
	if match.Status != MatchActive {
		return CommandResult{}, ErrMatchEnded
	}
	if match.Version != cmd.ExpectedVersion || match.ControlEpoch != cmd.ControlEpoch {
		return CommandResult{}, ErrConflict
	}
	opponent, ok := cmd.Seat.Other()
	if !ok {
		return CommandResult{}, ErrInvalidContract
	}
	opponentPresence, err := loadSeatPresence(ctx, tx, cmd.MatchID, opponent, decision)
	if err != nil {
		return CommandResult{}, err
	}
	availability := EvaluateClaim(ClaimInputs{
		MatchStatus:      match.Status,
		WhiteMoved:       match.Clock.WhiteMoved,
		BlackMoved:       match.Clock.BlackMoved,
		ReplyOutstanding: match.Clock.AwaitingOpeningReply(),
		Opponent:         opponentPresence,
		Now:              decision,
		ServiceState:     s.healthState(ctx),
	})
	if !availability.Eligible {
		return CommandResult{}, ErrActionNotAllowed
	}
	winner := cmd.Seat
	result := &Result{Kind: ResultWin, Winner: &winner, Reason: ReasonAbandonment}
	event, err := s.applyDeadlineResult(ctx, tx, match, clock, decision, EventAbandonmentClaim, cmd.Seat, result)
	if err != nil {
		return CommandResult{}, err
	}
	receipt := Receipt{
		SchemaVersion: ContractsSchemaVersion,
		MatchID:       cmd.MatchID,
		OperationID:   cmd.OperationID,
		Outcome:       OutcomeAccepted,
		Version:       event.Version,
		ControlEpoch:  match.ControlEpoch,
		DecidedAt:     decision,
		Event:         &event,
		Result:        result,
	}
	raw, err := marshalReceipt(receipt)
	if err != nil {
		return CommandResult{}, err
	}
	if err = insertMatchReceipt(ctx, tx, cmd.MatchID, cmd.OperationID, fingerprint[:], raw, event.Version, match.ControlEpoch, decision); err != nil {
		return CommandResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CommandResult{}, err
	}
	return CommandResult{Receipt: receipt, Raw: raw}, nil
}

// upsertHeartbeat writes the presence of one seat.
//
// The conflict update only applies to the row that belongs to the same
// participant, so a seat can never be taken over by another participant.
func (s *Service) upsertHeartbeat(ctx context.Context, tx pgx.Tx, matchID string, seat Seat, actor ParticipantRef, decision time.Time) (SeatPresence, error) {
	leaseExpires := decision.Add(PresenceLeaseTTL)
	var presence SeatPresence
	var ownerKind, ownerID string
	err := tx.QueryRow(ctx, `INSERT INTO online_presence(match_id,seat,owner_kind,owner_id,last_heartbeat_at,lease_expires_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$5)
ON CONFLICT (match_id,seat) DO UPDATE SET last_heartbeat_at=EXCLUDED.last_heartbeat_at,lease_expires_at=EXCLUDED.lease_expires_at,keep_waiting_at=NULL,updated_at=EXCLUDED.updated_at
WHERE online_presence.owner_kind=EXCLUDED.owner_kind AND online_presence.owner_id=EXCLUDED.owner_id
RETURNING seat,owner_kind,owner_id,last_heartbeat_at,lease_expires_at,keep_waiting_at`,
		matchID, string(seat), string(actor.Kind), actor.ID, decision, leaseExpires).
		Scan(&presence.Seat, &ownerKind, &ownerID, &presence.LastHeartbeatAt, &presence.LeaseExpiresAt, &presence.KeepWaitingAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return SeatPresence{}, ErrNotAuthorized
	}
	if err != nil {
		return SeatPresence{}, err
	}
	applyPresenceState(&presence, decision)
	return presence, nil
}

// markKeepWaiting records the choice to keep waiting.
//
// The choice belongs to the offline interval it was made in, so it is
// recorded against the seat the participant is waiting for. A heartbeat of
// the waiting participant never clears it, and the reconnect of the opponent
// clears it, because the interval it described is over.
func (s *Service) markKeepWaiting(ctx context.Context, tx pgx.Tx, matchID string, seat Seat, actor ParticipantRef, decision time.Time) (SeatPresence, error) {
	opponent, ok := seat.Other()
	if !ok {
		return SeatPresence{}, ErrInvalidContract
	}
	var presence SeatPresence
	var ownerKind, ownerID string
	err := tx.QueryRow(ctx, `UPDATE online_presence SET keep_waiting_at=$3,updated_at=$3 WHERE match_id=$1 AND seat=$2
RETURNING seat,owner_kind,owner_id,last_heartbeat_at,lease_expires_at,keep_waiting_at`,
		matchID, string(opponent), decision).
		Scan(&presence.Seat, &ownerKind, &ownerID, &presence.LastHeartbeatAt, &presence.LeaseExpiresAt, &presence.KeepWaitingAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return SeatPresence{}, ErrNotFound
	}
	if err != nil {
		return SeatPresence{}, err
	}
	applyPresenceState(&presence, decision)
	return presence, nil
}

// loadPresence reads the presence of both seats of a match.
func loadPresence(ctx context.Context, q queryer, matchID string, now time.Time) ([]SeatPresence, error) {
	rows, err := q.Query(ctx, `SELECT seat,last_heartbeat_at,lease_expires_at,keep_waiting_at FROM online_presence WHERE match_id=$1 ORDER BY CASE seat WHEN 'white' THEN 0 ELSE 1 END`, matchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]SeatPresence, 0, 2)
	for rows.Next() {
		var presence SeatPresence
		if err = rows.Scan(&presence.Seat, &presence.LastHeartbeatAt, &presence.LeaseExpiresAt, &presence.KeepWaitingAt); err != nil {
			return nil, err
		}
		applyPresenceState(&presence, now)
		out = append(out, presence)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// A seat that never reported in is still part of the view, so a client
	// never has to guess whether a presence record is missing.
	for _, seat := range []Seat{SeatWhite, SeatBlack} {
		found := false
		for _, presence := range out {
			if presence.Seat == seat {
				found = true
				break
			}
		}
		if !found {
			out = append(out, SeatPresence{Seat: seat, State: PresenceUnknown})
		}
	}
	return out, nil
}

// loadSeatPresence reads the presence of one seat. A seat that never reported
// in is unknown, not an error.
func loadSeatPresence(ctx context.Context, q queryer, matchID string, seat Seat, now time.Time) (SeatPresence, error) {
	presence := SeatPresence{Seat: seat, State: PresenceUnknown}
	err := q.QueryRow(ctx, `SELECT last_heartbeat_at,lease_expires_at,keep_waiting_at FROM online_presence WHERE match_id=$1 AND seat=$2`, matchID, string(seat)).
		Scan(&presence.LastHeartbeatAt, &presence.LeaseExpiresAt, &presence.KeepWaitingAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return presence, nil
	}
	if err != nil {
		return SeatPresence{}, err
	}
	applyPresenceState(&presence, now)
	return presence, nil
}

// applyPresenceState derives the liveness state of a presence record.
//
// The lease decides. A participant is connected while its lease holds and
// offline from the moment the lease expires, so a fresh heartbeat starts a
// fresh offline interval and a reconnect clears the claim eligibility.
func applyPresenceState(presence *SeatPresence, now time.Time) {
	if presence.LastHeartbeatAt == nil || presence.LeaseExpiresAt == nil {
		presence.State = PresenceUnknown
		presence.OfflineSince = nil
		return
	}
	last := presence.LastHeartbeatAt.UTC()
	lease := presence.LeaseExpiresAt.UTC()
	presence.LastHeartbeatAt = &last
	presence.LeaseExpiresAt = &lease
	if presence.KeepWaitingAt != nil {
		kept := presence.KeepWaitingAt.UTC()
		presence.KeepWaitingAt = &kept
	}
	if now.Before(lease) {
		presence.State = PresenceConnected
		presence.OfflineSince = nil
		return
	}
	presence.State = PresenceOffline
	offline := lease
	presence.OfflineSince = &offline
}

// actorSeat returns the seat a participant holds in a match.
func actorSeat(match Match, actor ParticipantRef) Seat {
	for _, seat := range match.Seats {
		if seat.Participant == actor {
			return seat.Seat
		}
	}
	return ""
}

// claimFingerprint hashes the authenticated claim intent.
//
// The fingerprint covers the same facts as the match command fingerprint, so
// an identical retry returns the stored receipt and a changed payload that
// reuses an accepted operation identifier is refused.
func claimFingerprint(actor ParticipantRef, cmd ClaimCommand) ([32]byte, error) {
	if err := actor.Validate(); err != nil {
		return [32]byte{}, err
	}
	if err := cmd.Validate(); err != nil {
		return [32]byte{}, err
	}
	type payload struct {
		SchemaVersion   int            `json:"schemaVersion"`
		MatchID         string         `json:"matchId"`
		OperationID     string         `json:"operationId"`
		ExpectedVersion int64          `json:"expectedVersion"`
		Seat            Seat           `json:"seat"`
		ControlEpoch    int64          `json:"controlEpoch"`
		Actor           ParticipantRef `json:"actor"`
		Action          string         `json:"action"`
	}
	raw, err := json.Marshal(payload{
		SchemaVersion:   cmd.SchemaVersion,
		MatchID:         cmd.MatchID,
		OperationID:     cmd.OperationID,
		ExpectedVersion: cmd.ExpectedVersion,
		Seat:            cmd.Seat,
		ControlEpoch:    cmd.ControlEpoch,
		Actor:           actor,
		Action:          "claim_abandonment",
	})
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(raw), nil
}
