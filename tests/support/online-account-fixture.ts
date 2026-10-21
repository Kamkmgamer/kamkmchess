/**
 * The bootstrap of a signed-in browser against the local online fixture.
 *
 * The fixture is the real service composition: the Go API, a real PostgreSQL
 * schema, the pinned private rules worker and the real authorization code. Its
 * accounts are synthetic identities signed by the fixture's own key and
 * verified by the fixture's own JWKS document, so a browser that presents one
 * of their session tokens is authenticated by the ordinary service code.
 *
 * Nothing here is a fetch double and no token is printed. The token is minted
 * for the run, handed to the page and used from there.
 */
import { createPrivateKey, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

/** The descriptor the fixture writes for the harness. */
export interface OnlineFixtureDescriptor {
  readonly baseUrl: string;
  readonly issuer: string;
  readonly allowedOrigins: readonly string[];
  readonly accounts: readonly { readonly id: string; readonly token: string }[];
  readonly keyPath: string;
}

/** The identity the page receives. */
interface PageIdentity {
  readonly accountId: string;
  readonly token: string;
}

/**
 * Reads the descriptor of the fixture of this run.
 *
 * The answer is null when the run has no fixture. The caller then skips the
 * rendered cases instead of testing a different service.
 */
export async function readOnlineFixtureDescriptor(path = process.env.ONLINE_FIXTURE_DESCRIPTOR ?? ''): Promise<OnlineFixtureDescriptor | null> {
  if (!path) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Partial<OnlineFixtureDescriptor>;
  if (typeof value.baseUrl !== 'string' || !value.baseUrl.startsWith('http://127.0.0.1')) return null;
  if (typeof value.issuer !== 'string' || typeof value.keyPath !== 'string') return null;
  if (!Array.isArray(value.accounts) || value.accounts.length === 0) return null;
  return {
    baseUrl: value.baseUrl,
    issuer: value.issuer,
    allowedOrigins: Array.isArray(value.allowedOrigins) ? value.allowedOrigins : [],
    accounts: value.accounts,
    keyPath: value.keyPath,
  };
}

/**
 * The account id of one fixture account.
 *
 * The id is shaped like the id of a hosted identity provider, because the
 * connection store of an **account** only accepts such an id: the namespace
 * of an account is the key its connections are stored under. The token is
 * minted for the same subject, so the service and the browser agree on the
 * account.
 */
export function fixtureAccountId(index: number): string {
  return `user_fixtureowner${String(index).padStart(4, '0')}aaaa`;
}

/**
 * Mints a short-lived session token for one of the fixture's accounts.
 *
 * The token is signed with the fixture's own key, so the service verifies it
 * exactly like a hosted session token. Nothing is bypassed.
 */
export async function mintOnlineFixtureToken(descriptor: OnlineFixtureDescriptor, accountId: string, lifetimeSeconds = 900): Promise<string> {
  const pem = await readFile(descriptor.keyPath, 'utf8');
  const key = createPrivateKey(pem);
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', kid: 'onlinefixture-key-1', typ: 'JWT' });
  const claims = encode({
    iss: descriptor.issuer,
    sub: accountId,
    sid: `sess_${accountId}`,
    azp: 'https://online.fixture.local',
    iat: now,
    exp: now + lifetimeSeconds,
    token_use: 'session',
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${signer.sign(key).toString('base64url')}`;
}

/**
 * Signs the page in as one of the fixture's accounts.
 *
 * The identity is put into the page before the application boots, so the
 * account surface starts signed in.
 */
export async function signInWithFixtureAccount(page: Page, descriptor: OnlineFixtureDescriptor, accountId: string): Promise<void> {
  const identity: PageIdentity = { accountId, token: await mintOnlineFixtureToken(descriptor, accountId) };
  await page.addInitScript((value: PageIdentity) => {
    (window as unknown as { __KAMKM_TEST_SESSION__: PageIdentity }).__KAMKM_TEST_SESSION__ = value;
  }, identity);
}

/**
 * Signs the page in as one of several fixture accounts.
 *
 * The page chooses its account with the `fixture-account` query parameter, so
 * a second page load of the same browser can sign in as another account
 * without a second seam. The tokens stay in the page; only the account name
 * is in the address.
 */
export async function signInWithFixtureAccounts(page: Page, descriptor: OnlineFixtureDescriptor, accountIds: readonly string[]): Promise<void> {
  const identities: PageIdentity[] = [];
  for (const accountId of accountIds) {
    identities.push({ accountId, token: await mintOnlineFixtureToken(descriptor, accountId) });
  }
  await page.addInitScript((values: PageIdentity[]) => {
    const wanted = new URLSearchParams(window.location.search).get('fixture-account');
    const found = values.find(value => value.accountId === wanted) ?? values[0];
    if (found) (window as unknown as { __KAMKM_TEST_SESSION__: PageIdentity }).__KAMKM_TEST_SESSION__ = found;
  }, identities);
}

/**
 * Changes the signed-in account of a running page.
 *
 * The page keeps the same browser and the same service, so the identity
 * change is the ordinary one: the work of the old account is fenced and the
 * games of the new account are restored.
 */
export async function switchFixtureAccount(page: Page, descriptor: OnlineFixtureDescriptor, accountId: string): Promise<void> {
  const identity: PageIdentity = { accountId, token: await mintOnlineFixtureToken(descriptor, accountId) };
  await page.evaluate((value: PageIdentity) => {
    window.dispatchEvent(new CustomEvent('kamkm:test-session', { detail: value }));
  }, identity);
}
