import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.js';
import { MatchComposition } from './ui/match-composition.js';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing.');

const composition = new MatchComposition();
const rootView = createRoot(root);
void composition.openActiveGame().then(async (session) => {
  const snapshot = await session.controller.initialize();
  rootView.render(
    <StrictMode>
      <App composition={composition} initialSession={session} initialSnapshot={snapshot} />
    </StrictMode>,
  );
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'The local chess game could not be opened.';
  rootView.render(<main role="alert"><h1>Chess could not start</h1><p>{message}</p></main>);
});
