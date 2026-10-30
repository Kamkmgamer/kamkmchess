import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './landing/App';
import { QuartzPortalProvider } from './lib/quartz/portal';
import { applyBoardStyle, getBoardStyle } from './ui/board-style.js';
import './landing/styles.css';

const root = document.getElementById('root');
document.body.classList.add('quartz');
applyBoardStyle(getBoardStyle());

if (!root) {
  throw new Error('The application root is missing.');
}

createRoot(root).render(
  <StrictMode>
    <QuartzPortalProvider>
      <App />
    </QuartzPortalProvider>
  </StrictMode>,
);
