-- KHA-75 friend invitations, one-use link joins, account challenges and
-- mutual rematches.
--
-- Additive only. Nothing in this file alters or re-grants the private
-- single-owner sync tables from 0001_storage.sql, and no existing shared row
-- is rewritten. The new tables keep no foreign keys into the private archive
-- and never store provider credentials, raw provider requests, AI
-- conversation, private endpoints, or owner archives.
--
-- Go is the only transaction writer. The kamkm_online_rules runtime role keeps
-- schema USAGE and no table privileges, so the private rules process cannot
-- read or write canonical online state.

-- A friend invitation is the durable record of one shareable invitation.
--
-- The invitation identifier is the shareable secret: it is the token of the
-- link and it is a bearer secret. Possession of the link never authorizes a
-- seat, a match or a command; it only allows one acceptance.
--
-- The inviter may be a signed-in account, a guest that already owns a seat, or
-- an anonymous guest that received an owner token. The owner token is stored
-- only as a hash and is the inviter's recoverable ownership of the
-- invitation and of the match it creates.
CREATE TABLE IF NOT EXISTS online_friend_invitations (
  invitation_id text PRIMARY KEY CHECK (invitation_id ~ '^inv_[A-Za-z0-9_-]{32,64}$'),
  kind text NOT NULL CHECK (kind IN ('link', 'challenge')),
  -- The stored state of the invitation. An open invitation whose deadline
  -- passed reads as expired, because the effective status is read from the
  -- deadline. The stored state therefore never has to be swept.
  status text NOT NULL CHECK (status IN ('open', 'consumed', 'cancelled', 'expired')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- The inviter identity. An anonymous guest inviter has a guest identity of
  -- its own and is shown as "Guest".
  inviter_kind text NOT NULL CHECK (inviter_kind IN ('account', 'guest')),
  inviter_id text NOT NULL CHECK (length(inviter_id) BETWEEN 1 AND 128),
  inviter_public_label text NOT NULL CHECK (length(inviter_public_label) BETWEEN 1 AND 64),
  inviter_control_kind text NOT NULL CHECK (inviter_control_kind IN ('human', 'agent')),
  inviter_model_label text CHECK (inviter_model_label IS NULL OR (length(inviter_model_label) BETWEEN 1 AND 64 AND inviter_model_label !~ '[[:cntrl:]]' AND inviter_model_label !~ '[@]' AND position('://' in inviter_model_label) = 0)),
  -- The color the inviter chose. The other seat belongs to the invitee.
  inviter_seat text NOT NULL CHECK (inviter_seat IN ('white', 'black')),
  starting_time_ms bigint NOT NULL CHECK (starting_time_ms BETWEEN 1 AND 86400000),
  increment_ms bigint NOT NULL CHECK (increment_ms BETWEEN 0 AND 60000),
  -- A custom position. A null value means the standard starting position.
  starting_fen text CHECK (starting_fen IS NULL OR (length(starting_fen) BETWEEN 4 AND 128 AND starting_fen !~ '[[:cntrl:]]')),
  -- The named recipient of an account challenge. A link invitation has no
  -- recipient and may be joined by a guest.
  recipient_account_id text CHECK (recipient_account_id IS NULL OR length(recipient_account_id) BETWEEN 1 AND 128),
  -- The revocable ownership secret of the inviter. Only its hash is stored.
  owner_token_hash bytea CHECK (owner_token_hash IS NULL OR octet_length(owner_token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  acceptance_id text,
  match_id text REFERENCES online_matches(match_id),
  CHECK ((inviter_control_kind = 'human') = (inviter_model_label IS NULL)),
  CHECK ((kind = 'challenge') = (recipient_account_id IS NOT NULL)),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (match_id IS NULL OR status = 'consumed'),
  CHECK (expires_at > created_at)
);
-- The effective status of an invitation is read from its deadline, so the
-- open invitations by their deadline are the ones a caller still sees.
CREATE INDEX IF NOT EXISTS online_friend_invitations_open ON online_friend_invitations(status, expires_at);
-- A named challenge is looked up by its recipient.
CREATE INDEX IF NOT EXISTS online_friend_invitations_recipient ON online_friend_invitations(recipient_account_id) WHERE recipient_account_id IS NOT NULL;

-- An acceptance is the durable record of one accepted invitation.
--
-- The acceptance is what makes an acceptance recoverable. The row records the
-- accepted seat, the declared control, the allocated guest identity and the
-- created match, so a retry after a lost answer resumes the same acceptance
-- instead of consuming a second invitation.
--
-- The acceptance key is the client-supplied idempotency key. Only its hash is
-- stored, so a leaked database row never resumes an acceptance. The key is
-- the only capability that resumes an acceptance: the public acceptance
-- identifier is never sufficient.
--
-- An account acceptor is bound to its own acceptance, because an account has
-- an identity the service can check. A guest acceptor has no other identity,
-- so the key is the whole capability of that acceptance. The key therefore
-- stays secret, it is never logged, and the service never returns it.
CREATE TABLE IF NOT EXISTS online_invitation_acceptances (
  acceptance_id text PRIMARY KEY CHECK (acceptance_id ~ '^acc_[A-Za-z0-9_-]{16,40}$'),
  invitation_id text NOT NULL REFERENCES online_friend_invitations(invitation_id) ON DELETE RESTRICT,
  acceptance_key_hash bytea NOT NULL CHECK (octet_length(acceptance_key_hash) = 32),
  acceptor_kind text NOT NULL CHECK (acceptor_kind IN ('account', 'guest')),
  acceptor_id text NOT NULL CHECK (length(acceptor_id) BETWEEN 1 AND 128),
  acceptor_public_label text NOT NULL CHECK (length(acceptor_public_label) BETWEEN 1 AND 64),
  seat text NOT NULL CHECK (seat IN ('white', 'black')),
  control_kind text NOT NULL CHECK (control_kind IN ('human', 'agent')),
  model_label text CHECK (model_label IS NULL OR (length(model_label) BETWEEN 1 AND 64 AND model_label !~ '[[:cntrl:]]' AND model_label !~ '[@]' AND position('://' in model_label) = 0)),
  -- The guest identity of a guest acceptor. It is allocated once, inside the
  -- transaction that consumes the invitation, and it is the seat owner of the
  -- created match, so the identity and the minted credential always agree.
  guest_id text CHECK (guest_id IS NULL OR length(guest_id) BETWEEN 1 AND 128),
  status text NOT NULL CHECK (status IN ('pending', 'matched', 'credentialed', 'failed')),
  match_id text REFERENCES online_matches(match_id),
  credential_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((control_kind = 'human') = (model_label IS NULL)),
  CHECK ((acceptor_kind = 'guest') = (guest_id IS NOT NULL)),
  CHECK ((acceptor_kind = 'guest') = (acceptor_id = guest_id)),
  CHECK ((status IN ('matched', 'credentialed')) = (match_id IS NOT NULL)),
  CHECK ((status = 'credentialed') = (credential_id IS NOT NULL))
);
-- One acceptance per key. A retry of the same key finds the same acceptance.
CREATE UNIQUE INDEX IF NOT EXISTS online_invitation_acceptances_key ON online_invitation_acceptances(invitation_id, acceptance_key_hash);
-- The acceptance, the canonical match and the guest seat credential commit
-- in one transaction, so a pending acceptance never survives a crash and no
-- reconciler has to look for an orphaned one. The index is the access path
-- of the acceptance state.
CREATE INDEX IF NOT EXISTS online_invitation_acceptances_pending ON online_invitation_acceptances(status, updated_at);

-- A rematch offer is one participant's proposal for a new game.
--
-- A rematch needs both participants. The proposal carries the proposer's
-- consent and the setup it proposes; the opponent accepts the exact offer by
-- naming it. The new match reverses the colors and retains the setup unless
-- the offer proposes a change the opponent agreed to.
CREATE TABLE IF NOT EXISTS online_rematch_offers (
  rematch_id text PRIMARY KEY CHECK (rematch_id ~ '^rmt_[A-Za-z0-9_-]{16,40}$'),
  match_id text NOT NULL REFERENCES online_matches(match_id) ON DELETE RESTRICT,
  proposer_kind text NOT NULL CHECK (proposer_kind IN ('account', 'guest')),
  proposer_id text NOT NULL CHECK (length(proposer_id) BETWEEN 1 AND 128),
  proposer_public_label text NOT NULL CHECK (length(proposer_public_label) BETWEEN 1 AND 64),
  -- The seat the proposer plays in the new match. The colors are reversed.
  proposer_seat text NOT NULL CHECK (proposer_seat IN ('white', 'black')),
  starting_time_ms bigint NOT NULL CHECK (starting_time_ms BETWEEN 1 AND 86400000),
  increment_ms bigint NOT NULL CHECK (increment_ms BETWEEN 0 AND 60000),
  starting_fen text CHECK (starting_fen IS NULL OR (length(starting_fen) BETWEEN 4 AND 128 AND starting_fen !~ '[[:cntrl:]]')),
  status text NOT NULL CHECK (status IN ('pending', 'accepting', 'accepted', 'superseded', 'declined', 'expired')),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  accepted_by_kind text CHECK (accepted_by_kind IS NULL OR accepted_by_kind IN ('account', 'guest')),
  accepted_by_id text CHECK (accepted_by_id IS NULL OR length(accepted_by_id) BETWEEN 1 AND 128),
  new_match_id text REFERENCES online_matches(match_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK ((status = 'accepted') = (new_match_id IS NOT NULL)),
  -- The accepter is recorded when the offer is accepted. The offer, the new
  -- match and the credential of the accepter commit together, so a durable
  -- reservation never outlives its acceptance and a crash leaves the offer
  -- open for the opponent.
  CHECK ((status IN ('accepting', 'accepted')) = (accepted_by_id IS NOT NULL)),
  CHECK (expires_at > created_at)
);
-- One pending offer per finished match. A newer proposal supersedes the older.
CREATE UNIQUE INDEX IF NOT EXISTS online_rematch_offers_pending ON online_rematch_offers(match_id) WHERE status = 'pending';

-- Runtime grants. Roles are cluster-scoped, so creation is best effort: a
-- migration role without CREATEROLE still applies the schema and skips grants.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['kamkm_online_api', 'kamkm_online_rules'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      EXCEPTION WHEN insufficient_privilege THEN
        RAISE NOTICE 'KHA-75: role % not created; runtime grants skipped', role_name;
      END;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  schema_name text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_api') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_friend_invitations TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_invitation_acceptances TO kamkm_online_api', schema_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.online_rematch_offers TO kamkm_online_api', schema_name);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kamkm_online_rules') THEN
    -- USAGE without table privileges: the rules process receives versioned input
    -- over its private channel and has no independent database authority.
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM kamkm_online_rules', schema_name);
  END IF;
END
$$;

-- New shared tables never fall back to PUBLIC access.
REVOKE ALL PRIVILEGES ON TABLE online_friend_invitations FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_invitation_acceptances FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE online_rematch_offers FROM PUBLIC;
