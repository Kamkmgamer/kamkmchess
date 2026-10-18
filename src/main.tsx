import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { MatchComposition } from './ui/match-composition.js';
import './ui/styles.css';
import { publicConfig } from './public-config.js';

const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing.');

const composition = new MatchComposition();
const rootView = createRoot(root);
void composition.openActiveGame().then(async (session) => {
  const snapshot = await session.controller.initialize();
  if (publicConfig.accountsEnabled) {
    const { AccountWorkspace } = await import('./AccountWorkspace.js');
    rootView.render(<StrictMode><AccountWorkspace composition={composition} initialSession={session} initialSnapshot={snapshot} /></StrictMode>);
    return;
  }
  rootView.render(
    <StrictMode>
      <App composition={composition} initialSession={session} initialSnapshot={snapshot} />
    </StrictMode>,
  );
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'The local chess game could not be opened.';
  rootView.render(<main className="focus-page" role="alert" aria-description={message}><h1>Couldn’t open chess</h1><button onClick={() => window.location.reload()}>Reload</button></main>);
});
