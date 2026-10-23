/**
 * The site owner's switches of the online surfaces.
 *
 * The deployment configures whether friend play and the public queue are
 * open. An account the service names as an owner can override that from the
 * site; every other account is refused, which is how the page knows to hide
 * the controls.
 */

export interface OnlineSwitchState {
  readonly friends: boolean;
  readonly queue: boolean;
}

export interface OwnerSwitchesAnswer {
  readonly state: OnlineSwitchState;
  /** The configured state, so the owner can see what is overridden. */
  readonly defaults: OnlineSwitchState;
}

export interface OwnerSwitches {
  /** The switches, or null when this account is not an owner. */
  read(): Promise<OwnerSwitchesAnswer | null>;
  write(state: OnlineSwitchState): Promise<OwnerSwitchesAnswer>;
}

export interface OwnerSwitchesOptions {
  readonly baseUrl: string;
  /** Mints a fresh session token for the signed-in account. */
  readonly token: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

function readState(value: unknown): OnlineSwitchState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { friends, queue } = value as Record<string, unknown>;
  return typeof friends === 'boolean' && typeof queue === 'boolean' ? { friends, queue } : null;
}

function readAnswer(body: unknown): OwnerSwitchesAnswer {
  const state = readState(body);
  const defaults = readState(typeof body === 'object' && body !== null ? (body as Record<string, unknown>).defaults : null);
  if (!state || !defaults) throw new Error('The service sent an unexpected answer.');
  return { state, defaults };
}

export function createOwnerSwitches({ baseUrl, token, fetch: fetcher = (input, init) => globalThis.fetch(input, init) }: OwnerSwitchesOptions): OwnerSwitches {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/account/online-switches`;
  async function call(init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await token()}` };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetcher(url, { ...init, headers, credentials: 'omit', cache: 'no-store', redirect: 'error' });
  }
  return {
    async read() {
      const response = await call({ method: 'GET' });
      // 403 is another account; 404 is a service without owners.
      if (response.status === 403 || response.status === 404) return null;
      if (!response.ok) throw new Error('The online switches could not be read.');
      return readAnswer(await response.json());
    },
    async write(state) {
      const response = await call({ method: 'PUT', body: JSON.stringify(state) });
      if (!response.ok) throw new Error('The online switches could not be saved.');
      return readAnswer(await response.json());
    },
  };
}
