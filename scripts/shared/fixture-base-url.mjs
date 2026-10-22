// The one rule for the address of the local online fixture.
//
// The base URL of the descriptor is the address the credential of the fixture
// travels to: the tooling mints a signed session token with the fixture key
// and sends it to that address. The shape of the address therefore decides
// where a secret goes, and the address is checked by parsing it, not by
// comparing a prefix of its text.
//
// A prefix is not a check. `http://127.0.0.1:18099@attacker.example` starts
// with the loopback address and the URL parser reads it as the user info
// `127.0.0.1:18099` and the host `attacker.example`, so the token would be
// sent to another host. The same is true of `http://127.0.0.1.attacker.example`
// and of every other shape that only looks like the loopback address.
//
// The accepted address is the one the Go fixture writes
// (`http://127.0.0.1:<port>`): the http scheme, the exact loopback host of the
// fixture, an optional port of the fixture and nothing else. There is no user
// name and no password, no path, no query and no fragment, because each of
// them sends the credential somewhere else or along another route. There is
// no whitespace and no control character either, because the URL parser drops
// them and the reader of the descriptor would not see the address the token
// is really sent to.
//
// This module is the single definition of that shape. The Node tooling of the
// fixture (`scripts/online/fixture-client.mjs`) and the browser suites of the
// repository (`tests/support/online-fixture-descriptor.ts`) both import it,
// so the two cannot drift apart and leave one of them sending a fixture token
// off the host of the fixture. The module is plain ESM without a dependency of
// Node, so both of them can read it.

/** The host the fixture binds. */
export const FIXTURE_LOOPBACK_HOST = '127.0.0.1';

/**
 * The URL of a value, or null when the value is not a URL.
 * @param {string} value
 * @returns {URL | null}
 */
function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * The problem of a base URL, or null when it is the base URL of the fixture.
 *
 * @param {unknown} value
 * @returns {string | null} the reason the value is refused, or null
 */
export function describeFixtureBaseUrlProblem(value) {
  if (typeof value !== 'string') return 'the base URL is not a string';
  if (value.length === 0) return 'the base URL is empty';
  if (value !== value.trim()) return 'the base URL carries whitespace around it';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return 'the base URL carries whitespace or control characters';
  }
  const url = parseUrl(value);
  if (url === null) return 'the base URL is not a URL';
  if (url.protocol !== 'http:') return `the scheme of the base URL is ${url.protocol} and not http`;
  if (url.username !== '' || url.password !== '') return 'the base URL carries a user name or a password';
  if (url.hostname !== FIXTURE_LOOPBACK_HOST) {
    return `the host of the base URL is ${url.hostname} and not the loopback host of the fixture`;
  }
  if (url.pathname !== '/') return `the base URL has the path ${url.pathname}`;
  if (url.search !== '') return 'the base URL has a query';
  if (url.hash !== '') return 'the base URL has a fragment';
  if (url.port !== '' && Number(url.port) < 1) return 'the base URL has no port of the fixture';
  return null;
}

/**
 * Whether the value is the base URL of the fixture.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isFixtureBaseUrl(value) {
  return describeFixtureBaseUrlProblem(value) === null;
}
