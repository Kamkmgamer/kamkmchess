/**
 * Default public-name seeding.
 *
 * A public profile exists the moment an account first reads it, but the public
 * name used to start empty, so every account met a setup step before it had a
 * name anybody could see. The seed removes that step: the browser already
 * holds the account's own sign-in fields, so it proposes them once, and the
 * service derives the stored name under its own rules.
 *
 * The seed is a default, not a choice. It only ever names a profile that has
 * no name, it runs at most once per signed-in identity, and a failure changes
 * nothing: the account keeps the generated identity it already has, and the
 * profile panel still offers the deliberate choice.
 */
import type { ProfileClient } from './client';
import type { PublicProfile } from './contracts';

/**
 * The account fields a public name can be derived from.
 *
 * The shape is the account client's user port, so the seed reads the fields
 * the sign-in already published to this browser and never asks for anything
 * else. The fields are proposals: the service derives and validates every
 * candidate again.
 */
export interface AccountNameSource {
  readonly username?: string | null;
  readonly fullName?: string | null;
  readonly primaryEmailAddress?: { readonly emailAddress: string } | null;
}

/**
 * Proposes the candidate texts of one account, in the order the account
 * presents them.
 *
 * The account username comes first because it is the name the person chose for
 * the account. The full name follows, and the local part of the email address
 * is the last resort of an account that published neither.
 */
export function accountNameCandidates(source: AccountNameSource): string[] {
  const candidates: string[] = [];
  if (source.username && source.username.trim().length > 0) candidates.push(source.username.trim());
  if (source.fullName && source.fullName.trim().length > 0) candidates.push(source.fullName.trim());
  const email = source.primaryEmailAddress?.emailAddress;
  if (email) {
    const local = email.split('@')[0]?.trim() ?? '';
    if (local.length > 0) candidates.push(local);
  }
  return candidates;
}

/**
 * Seeds the default public name of the signed-in account.
 *
 * Returns the seeded profile, or null when there was nothing to do: the
 * profile already has a name, or the account published no text a name could be
 * derived from. A refused or failed seed propagates to the caller, which runs
 * it quietly in the background and tries again on the next sign-in.
 */
export async function seedDefaultPublicName(client: ProfileClient, source: AccountNameSource): Promise<PublicProfile | null> {
  const profile = await client.readOwnProfile();
  if (profile.username !== null) return null;
  const candidates = accountNameCandidates(source);
  if (candidates.length === 0) return null;
  const seeded = await client.seedOwnProfileName(candidates);
  return seeded.username === profile.username ? null : seeded;
}
