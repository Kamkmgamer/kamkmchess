import { describe, expect, it } from 'vitest';
import { createOwnerSwitches } from './owner-switches.js';

const answer = { friends: true, queue: false, defaults: { friends: false, queue: false } };

function service(status: number, body: unknown = answer) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({ status, ok: status >= 200 && status < 300, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
  return { calls, switches: createOwnerSwitches({ baseUrl: 'https://api.example/', token: () => Promise.resolve('session'), fetch: fetcher }) };
}

describe('owner switches', () => {
  it('reads the switches with the account token', async () => {
    const { calls, switches } = service(200);
    expect(await switches.read()).toEqual({ state: { friends: true, queue: false }, defaults: { friends: false, queue: false } });
    expect(calls[0]?.url).toBe('https://api.example/v1/account/online-switches');
    expect(calls[0]?.init.headers).toEqual({ Authorization: 'Bearer session' });
    expect(calls[0]?.init.credentials).toBe('omit');
  });

  it('hides the controls from accounts that are not owners', async () => {
    expect(await service(403, { error: 'not_owner' }).switches.read()).toBeNull();
    expect(await service(404).switches.read()).toBeNull();
    await expect(service(503).switches.read()).rejects.toThrow();
  });

  it('writes both switches at once', async () => {
    const { calls, switches } = service(200);
    await switches.write({ friends: true, queue: false });
    expect(calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ friends: true, queue: false });
    await expect(service(200, { friends: true }).switches.write({ friends: true, queue: true })).rejects.toThrow();
  });
});
