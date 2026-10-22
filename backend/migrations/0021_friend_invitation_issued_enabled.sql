-- KHA-75 the persisted enablement of a friend invitation.
--
-- The friend surface is a rollback switch. Turning it off stops new
-- creations immediately, and it never invalidates an invitation that was
-- issued while the switch was open: a guest may still accept such an
-- invitation, and its inviter may still cancel it and claim the seat
-- credential of the created match.
--
-- The row records that fact. The column is true for every invitation the
-- service issued while friend play was enabled, and it is read before a
-- request of a closed surface is served, so the allow-while-off path never
-- widens into an arbitrary invitation.
--
-- Additive only. The column is added with its default, so no existing row is
-- rewritten and no existing invitation loses its enablement.

ALTER TABLE online_friend_invitations
  ADD COLUMN IF NOT EXISTS issued_while_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN online_friend_invitations.issued_while_enabled IS
  'true when the invitation was issued while friend play was enabled; a closed surface still finishes such an invitation';
