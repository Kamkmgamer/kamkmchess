/**
 * The preview of one friend invitation (KHA-75).
 *
 * The preview is the canonical metadata of an invitation: the inviter, the
 * color of the inviter, the color the invitee receives, the clock and the
 * custom position. The invitee reads it before the acceptance, so the board
 * the inviter chose is never a surprise.
 */
import type { FriendInvitation } from '../online/friend-routes.js';
import { friendInvitationPreview } from './friend-setup.js';

export interface FriendInvitationPreviewProps {
  /** The invitation the service published. */
  readonly invitation: FriendInvitation;
}

/** The preview of one friend invitation. */
export function FriendInvitationPreview({ invitation }: FriendInvitationPreviewProps) {
  return <p role="status">{friendInvitationPreview(invitation)}</p>;
}
