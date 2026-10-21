import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { OnlineWorkspace } from './ui/online-workspace.js';
import { MatchComposition } from './ui/match-composition.js';
import { createOnlineComposition } from './online/composition.js';
import { createAgentReadinessCheck } from './online/agent-readiness.js';
import { createBrowserEnginePreparation } from './online/engine-preparation.js';
import './ui/styles.css';
import './ui/mobile.css';
import { publicConfig } from './public-config.js';

const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing.');

const composition = new MatchComposition();
// The online composition exists when a service origin is configured. A test
// build may also open it with the `online` query switch, so the surface is
// reachable without a service: the service still owns the rollout and every
// online surface stays closed when the service does not open it.
const onlineOptIn = new URLSearchParams(window.location.search).has('online');
const onlineOrigin = publicConfig.apiBaseUrl ?? (onlineOptIn ? window.location.origin : null);
// The browser engine and the own-agent check are browser-owned. The service
// never sees a provider credential and never runs an engine.
const enginePreparation = createBrowserEnginePreparation();
const checkModel = createAgentReadinessCheck({
  opponentService: composition.opponentService,
  connectionStore: composition.connectionStore,
  namespace: composition.namespace,
});
const online = onlineOrigin
  ? createOnlineComposition({
    baseUrl: onlineOrigin,
    search: window.location.search,
    prepareEngine: () => enginePreparation.prepare(),
    checkModel,
  })
  : null;
// The service owns the rollout of the online surfaces. The browser asks
// once, without a credential, and keeps the answer for the page lifetime.
void online?.loadFeatures();
const rootView = createRoot(root);
/**
 * The published invitation link opens the online screen.
 *
 * The link carries the exact invitation, so the owner reads its preview and
 * accepts that invitation. The offline game stays untouched underneath.
 */
function linkedInvitationId(): string | null {
  const linked = new URLSearchParams(window.location.search).get('invite');
  if (linked) return linked;
  const segments = window.location.pathname.split('/').filter(Boolean);
  const index = segments.indexOf('invite');
  return index >= 0 ? segments[index + 1] ?? null : null;
}
const linkedInvitation = linkedInvitationId();

void composition.openActiveGame().then(async (session) => {
  const snapshot = await session.controller.initialize();
  if (publicConfig.accountsEnabled) {
    const { AccountWorkspace } = await import('./AccountWorkspace.js');
    rootView.render(<StrictMode><AccountWorkspace composition={composition} initialSession={session} initialSnapshot={snapshot} online={online} /></StrictMode>);
    return;
  }
  rootView.render(
    <StrictMode>
      <App composition={composition} initialSession={session} initialSnapshot={snapshot} online={online} />
      {online && linkedInvitation && <OnlineWorkspace composition={online} onClose={() => { window.location.href = '/play'; }} initialTab="new" />}
    </StrictMode>,
  );
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'The local chess game could not be opened.';
  rootView.render(<main className="focus-page" role="alert" aria-description={message}><h1>Couldn’t open chess</h1><button onClick={() => window.location.reload()}>Reload</button></main>);
});
