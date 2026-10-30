import type { CSSProperties } from 'react';

/**
 * The hue of a generated avatar.
 *
 * The generated avatar is derived from the public profile identifier, so it
 * is stable for a person and needs no storage. The hue is only a starting
 * point; the swatch keeps its own contrast.
 */
export function generatedProfileHue(profileId: string): CSSProperties {
  let hash = 0;
  for (let index = 0; index < profileId.length; index += 1) {
    hash = (hash * 31 + profileId.charCodeAt(index)) % 360;
  }
  return { '--profile-hue': String(hash) } as CSSProperties;
}
