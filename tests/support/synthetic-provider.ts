/**
 * A deterministic local provider for the rendered online cases.
 *
 * The provider is a real HTTP server on loopback. The browser talks to it
 * with its ordinary provider client, so the request, the answer and the
 * reported model are the real ones. No provider is contacted and no request
 * is intercepted.
 *
 * The server answers the two kinds of request the product makes:
 *
 * - the catalog request, which lists the models of the connection;
 * - the generation request, which answers with one legal move of the
 *   position the request carries, or with the fixed diagnostic answer when
 *   the request carries the diagnostic markers.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Chess } from 'chess.js';

export interface SyntheticProviderRequest {
  readonly path: string;
  readonly body: string;
}

export interface SyntheticProvider {
  /** The base URL of the provider. */
  readonly baseUrl: string;
  /** The models the provider advertises. */
  readonly models: readonly string[];
  /** Every request the provider received. */
  readonly requests: readonly SyntheticProviderRequest[];
  /** The generation requests the provider received. */
  readonly generationRequests: readonly SyntheticProviderRequest[];
  close(): Promise<void>;
}

export interface SyntheticProviderOptions {
  /** The models the catalog lists. */
  readonly models?: readonly string[];
  /** The name the catalog gives every model. */
  readonly displayName?: string;
}

/** The first legal move of a position, in the coordinate form the product uses. */
function firstLegalMove(fen: string | undefined): string {
  if (!fen) return 'e2e4';
  try {
    const chess = new Chess(fen);
    const moves = chess.moves({ verbose: true });
    const first = moves[0];
    if (!first) return 'e2e4';
    return `${first.from}${first.to}${first.promotion ?? ''}`;
  } catch {
    return 'e2e4';
  }
}

/**
 * The answer of one generation request.
 *
 * The diagnostic request carries a plan marker and a response marker. The
 * answer copies both, so the compatibility check of the product passes
 * against a real provider.
 */
function answerFor(body: string): string {
  const plan = /KAMKM-PRIOR-PLAN-[A-Za-z0-9-]+/.exec(body)?.[0];
  const marker = /KAMKM-COMPAT-[A-Za-z0-9-]+/.exec(body)?.[0];
  if (plan && marker) return JSON.stringify({ move: 'e2e4', plan, marker });
  const fen = /"fen"\s*:\s*"([^"]+)"/.exec(body)?.[1];
  return JSON.stringify({ move: firstLegalMove(fen), plan: 'synthetic local plan' });
}

/** Starts the local provider of one rendered case. */
export async function startSyntheticProvider(options: SyntheticProviderOptions = {}): Promise<SyntheticProvider> {
  const models = options.models ?? ['synthetic-a', 'synthetic-b'];
  const requests: SyntheticProviderRequest[] = [];
  const generationRequests: SyntheticProviderRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = request.url ?? '/';
      requests.push({ path, body });
      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(204, headers);
        response.end();
        return;
      }
      if (path.endsWith('/models')) {
        response.writeHead(200, { ...headers, 'content-type': 'application/json' });
        response.end(JSON.stringify({
          object: 'list',
          data: models.map(id => (options.displayName === undefined ? { id } : { id, name: options.displayName })),
        }));
        return;
      }
      generationRequests.push({ path, body });
      const frames = [
        { model: models[0] ?? 'synthetic', choices: [{ index: 0, delta: { content: answerFor(body) }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 25, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 0 } } },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
      response.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.end(frames);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models,
    requests,
    generationRequests,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
  };
}
