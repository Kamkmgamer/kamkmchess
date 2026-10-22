package invite

import (
	"context"
	"errors"
	"testing"

	"github.com/Kamkmgamer/kamkmchess/backend/online"
)

// TestTheAcceptanceKeyShape covers the capability that resumes an
// acceptance.
func TestTheAcceptanceKeyShape(t *testing.T) {
	if err := validateAcceptanceKey("0123456789abcdef"); err != nil {
		t.Fatalf("a valid acceptance key was refused: %v", err)
	}
	for _, invalid := range []string{"", "short", "with space 1234567890", "with/slash/1234567890"} {
		if err := validateAcceptanceKey(invalid); err == nil {
			t.Fatalf("the malformed acceptance key %q was accepted", invalid)
		}
	}
}

// TestTheFriendSeatControlHasNoEngineSeat covers the friend setup rule.
//
// There is no built-in engine seat in friend play, and a human seat never
// declares a model.
func TestTheFriendSeatControlHasNoEngineSeat(t *testing.T) {
	if err := validateSeatControl(online.SeatControl{Kind: online.ControlHuman}); err != nil {
		t.Fatalf("a human seat was refused: %v", err)
	}
	if err := validateSeatControl(online.SeatControl{Kind: online.ControlHuman, ModelLabel: stringPointer("Model")}); err == nil {
		t.Fatal("a human seat with a model was accepted")
	}
	label := "Declared Model"
	if err := validateSeatControl(online.SeatControl{Kind: online.ControlAgent, ModelLabel: &label}); err != nil {
		t.Fatalf("an agent seat was refused: %v", err)
	}
	if err := validateSeatControl(online.SeatControl{Kind: online.ControlAgent}); err == nil {
		t.Fatal("an agent seat without a public model label was accepted")
	}
	if err := validateSeatControl(online.SeatControl{Kind: online.ControlEngine, ModelLabel: &label}); err == nil {
		t.Fatal("an engine seat was accepted in friend setup")
	}
}

// TestTheRematchSetupHasNoEngineSeat covers the friend setup rule of a
// rematch.
//
// A friend game seats a human or the owner of its own agent. A queue
// fallback match holds a browser Stockfish seat, and that seat has no friend
// consent path and no engine seat client, so it can never be carried into a
// friend rematch.
func TestTheRematchSetupHasNoEngineSeat(t *testing.T) {
	owner := online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_owner"}
	engine := online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest_engine_stockfish"}
	modelLabel := "Declared Model"
	engineLabel := "Stockfish 19 Lite (browser)"

	human := online.MatchSeat{Seat: online.SeatWhite, Participant: owner, PublicLabel: "Owner", Control: online.SeatControl{Kind: online.ControlHuman}}
	agent := online.MatchSeat{Seat: online.SeatBlack, Participant: engine, PublicLabel: "Bob", Control: online.SeatControl{Kind: online.ControlAgent, ModelLabel: &modelLabel}}
	browserEngine := online.MatchSeat{Seat: online.SeatBlack, Participant: engine, PublicLabel: "Stockfish 19 Lite", Control: online.SeatControl{Kind: online.ControlEngine, ModelLabel: &engineLabel}}

	// A human seat and an owner agent seat are friend seats.
	if err := validateRematchSetup(online.Match{Seats: []online.MatchSeat{human, agent}}); err != nil {
		t.Fatalf("the setup of a friend match was refused: %v", err)
	}
	// A browser engine seat is not a friend seat, so the setup of a queue
	// fallback match cannot be carried into a friend rematch.
	if err := validateRematchSetup(online.Match{Seats: []online.MatchSeat{human, browserEngine}}); !errors.Is(err, ErrInvalidContract) {
		t.Fatalf("the setup of an engine match = %v, want ErrInvalidContract", err)
	}
	// The engine seat is refused in either seat.
	if err := validateRematchSetup(online.Match{Seats: []online.MatchSeat{browserEngine, human}}); !errors.Is(err, ErrInvalidContract) {
		t.Fatalf("the setup of an engine match = %v, want ErrInvalidContract", err)
	}
}

// TestThePublicLabelRejectsAnEmailOrAnEndpoint covers the published label
// rules.
func TestThePublicLabelRejectsAnEmailOrAnEndpoint(t *testing.T) {
	for _, valid := range []string{"Alice", "player_1", "Guest"} {
		if err := validatePublicLabel(valid); err != nil {
			t.Fatalf("the label %q was refused: %v", valid, err)
		}
	}
	for _, invalid := range []string{"", " alice", "alice@example.com", "https://example.com", "line\nbreak"} {
		if err := validatePublicLabel(invalid); err == nil {
			t.Fatalf("the label %q was accepted", invalid)
		}
	}
}

// TestTheAcceptanceKeyIsStoredOnlyAsAHash covers the stored capability.
func TestTheAcceptanceKeyIsStoredOnlyAsAHash(t *testing.T) {
	key := "0123456789abcdef"
	hash := hashAcceptanceKey(key)
	if len(hash) != 32 {
		t.Fatalf("the acceptance key hash is %d bytes", len(hash))
	}
	if subtleEqual(hash, []byte(key)) {
		t.Fatal("the stored hash is the key itself")
	}
	if !subtleEqual(hash, hashAcceptanceKey(key)) {
		t.Fatal("the hash is not stable")
	}
	if subtleEqual(hash, hashAcceptanceKey("0123456789abcdeg")) {
		t.Fatal("two different keys share a hash")
	}
	if subtleEqual(hashOwnerToken("owner"), hashAcceptanceKey("owner")) {
		t.Fatal("the owner token and the acceptance key share a stored value")
	}
}

// stringPointer returns a pointer to a copy of the value.
func stringPointer(value string) *string {
	return &value
}

// stubRecipientResolver resolves one public name.
type stubRecipientResolver struct {
	account string
	err     error
	asked   string
}

func (r *stubRecipientResolver) AccountIDByUsername(_ context.Context, username string) (string, error) {
	r.asked = username
	if r.err != nil {
		return "", r.err
	}
	return r.account, nil
}

// TestTheChallengeNamesThePublicNameOfTheRecipient covers the recipient of a
// named challenge.
//
// The public request names a public name and the service resolves it, so an
// authentication identifier never crosses the boundary of the request.
func TestTheChallengeNamesThePublicNameOfTheRecipient(t *testing.T) {
	resolver := &stubRecipientResolver{account: "user_recipient"}
	service := &Service{recipients: resolver}
	ctx := context.Background()

	accountID, err := service.resolveRecipient(ctx, KindChallenge, CreateRequest{RecipientUsername: "recipient_name"})
	if err != nil {
		t.Fatalf("the challenge of a public name was refused: %v", err)
	}
	if accountID != "user_recipient" {
		t.Fatalf("the resolved recipient = %q, want the account", accountID)
	}
	if resolver.asked != "recipient_name" {
		t.Fatalf("the resolver saw %q, want the public name", resolver.asked)
	}

	// A shareable link names nobody.
	if _, err = service.resolveRecipient(ctx, KindLink, CreateRequest{RecipientUsername: "recipient_name"}); !errors.Is(err, ErrInvalidContract) {
		t.Fatalf("the link of a named recipient = %v, want ErrInvalidContract", err)
	}
	if _, err = service.resolveRecipient(ctx, KindLink, CreateRequest{RecipientAccountID: "user_recipient"}); !errors.Is(err, ErrInvalidContract) {
		t.Fatalf("the link of a named account = %v, want ErrInvalidContract", err)
	}
	// A challenge names its recipient once.
	if _, err = service.resolveRecipient(ctx, KindChallenge, CreateRequest{}); !errors.Is(err, ErrInvalidContract) {
		t.Fatalf("the challenge without a recipient = %v, want ErrInvalidContract", err)
	}
	if _, err = service.resolveRecipient(ctx, KindChallenge, CreateRequest{
		RecipientUsername:  "recipient_name",
		RecipientAccountID: "user_recipient",
	}); !errors.Is(err, ErrInvalidContract) {
		t.Fatalf("the challenge with two recipients = %v, want ErrInvalidContract", err)
	}
	// An unknown public name is refused.
	resolver.err = ErrRecipientNotFound
	if _, err = service.resolveRecipient(ctx, KindChallenge, CreateRequest{RecipientUsername: "nobody"}); !errors.Is(err, ErrRecipientNotFound) {
		t.Fatalf("the challenge of an unknown name = %v, want ErrRecipientNotFound", err)
	}
	// A resolver that answers with nothing is refused as well.
	resolver.err = nil
	resolver.account = "  "
	if _, err = service.resolveRecipient(ctx, KindChallenge, CreateRequest{RecipientUsername: "recipient_name"}); !errors.Is(err, ErrRecipientNotFound) {
		t.Fatalf("the challenge of an empty account = %v, want ErrRecipientNotFound", err)
	}
}

// TestTheNamedChallengeNeedsAnAccountInviter covers the authority of a named
// challenge.
//
// A shareable link is a bearer secret, and a guest may create one. A named
// challenge names an account of the surface, so only an account may create
// one.
func TestTheNamedChallengeNeedsAnAccountInviter(t *testing.T) {
	anonymous := (*Identity)(nil)
	guest := &Identity{Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest_inviter"}, PublicLabel: GuestLabel}
	account := &Identity{Participant: online.ParticipantRef{Kind: online.ParticipantAccount, ID: "user_inviter"}, PublicLabel: "Alice"}

	// An account may create a named challenge.
	if err := validateChallengeInviter(KindChallenge, account); err != nil {
		t.Fatalf("the challenge of an account was refused: %v", err)
	}
	// A guest may create a shareable link, with or without an identity.
	if err := validateChallengeInviter(KindLink, anonymous); err != nil {
		t.Fatalf("the link of an anonymous inviter was refused: %v", err)
	}
	if err := validateChallengeInviter(KindLink, guest); err != nil {
		t.Fatalf("the link of a guest inviter was refused: %v", err)
	}
	// A named challenge needs an account inviter.
	for name, inviter := range map[string]*Identity{"anonymous": anonymous, "guest": guest} {
		if err := validateChallengeInviter(KindChallenge, inviter); !errors.Is(err, ErrNotAuthorized) {
			t.Fatalf("the challenge of a %s inviter = %v, want ErrNotAuthorized", name, err)
		}
	}
}

// TestTheServiceRefusesTheChallengeOfACallerWithoutAnAccount covers the
// service boundary of the rule.
//
// The refusal happens before any database work, so the rule belongs to the
// service and holds for every caller of it, not only for the browser that
// asked for the invitation.
func TestTheServiceRefusesTheChallengeOfACallerWithoutAnAccount(t *testing.T) {
	service := &Service{}
	ctx := context.Background()
	guest := &Identity{Participant: online.ParticipantRef{Kind: online.ParticipantGuest, ID: "guest_inviter"}, PublicLabel: GuestLabel}

	// An anonymous caller may not create a named challenge.
	if _, err := service.Create(ctx, CreateRequest{
		Kind:              KindChallenge,
		RecipientUsername: "recipient_name",
		Seat:              online.SeatWhite,
		TimeControl:       online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:           online.SeatControl{Kind: online.ControlHuman},
	}); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("the challenge of an anonymous caller = %v, want ErrNotAuthorized", err)
	}
	// A guest that holds a seat credential may not create one either.
	if _, err := service.Create(ctx, CreateRequest{
		Kind:              KindChallenge,
		Inviter:           guest,
		RecipientUsername: "recipient_name",
		Seat:              online.SeatWhite,
		TimeControl:       online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:           online.SeatControl{Kind: online.ControlHuman},
	}); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("the challenge of a guest = %v, want ErrNotAuthorized", err)
	}
	// The refusal is the same refusal for every named recipient, so it never
	// reveals whether the recipient exists.
	if _, err := service.Create(ctx, CreateRequest{
		Kind:              KindChallenge,
		Inviter:           guest,
		RecipientUsername: "nobody_owns_this_name",
		Seat:              online.SeatWhite,
		TimeControl:       online.TimeControl{StartingTimeMs: 300_000, IncrementMs: 0},
		Control:           online.SeatControl{Kind: online.ControlHuman},
	}); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("the challenge of an unknown name = %v, want ErrNotAuthorized", err)
	}
}

// TestTheFriendGateReportsTheStateOfTheSurface covers the rollback switch of
// the friend surface.
func TestTheFriendGateReportsTheStateOfTheSurface(t *testing.T) {
	if !StaticGate(true).FriendsEnabled() {
		t.Fatal("the open gate reports a closed surface")
	}
	if StaticGate(false).FriendsEnabled() {
		t.Fatal("the closed gate reports an open surface")
	}
	// A service without a gate keeps the surface open, so a caller that does
	// not configure the rollout keeps the historical behaviour.
	open := &Service{}
	if !open.friendsEnabled() {
		t.Fatal("the service without a gate closed the surface")
	}
	// A closed surface still serves an invitation that was issued while it
	// was open.
	if err := open.servesIssued(true); err != nil {
		t.Fatalf("the open surface refused an issued invitation: %v", err)
	}
	closed := &Service{gate: StaticGate(false)}
	if err := closed.servesIssued(true); err != nil {
		t.Fatalf("the closed surface refused an issued invitation: %v", err)
	}
	if err := closed.servesIssued(false); !errors.Is(err, ErrDisabled) {
		t.Fatalf("the closed surface served an invitation it did not issue: %v", err)
	}
}
