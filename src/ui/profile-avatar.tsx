import { generatedProfileHue } from './profile-hue.js';
import './profile-avatar.css';

/**
 * The avatar of a public profile, chosen or generated.
 *
 * A profile avatar is never an image URL: it is a catalog swatch, or a
 * gradient derived from the profile identifier, so it is stable for a
 * person and carries nothing about their account.
 */
export function ProfileAvatarView({ avatar, profileId }: {
  readonly avatar: { readonly kind: string; readonly value: string };
  readonly profileId: string;
}) {
  if (avatar.kind === 'chosen') {
    return <span className="profile-avatar" data-avatar={avatar.value} aria-hidden="true" />;
  }
  return <span className="profile-avatar" data-avatar="generated" style={generatedProfileHue(profileId || avatar.value)} aria-hidden="true" />;
}
