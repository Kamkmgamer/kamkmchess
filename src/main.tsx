import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { QuartzPortalProvider } from './lib/quartz/portal';
import './ui/styles.css';

const root = document.getElementById('root');

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
