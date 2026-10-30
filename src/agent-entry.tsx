import { createRoot } from 'react-dom/client';
import { AgentGame } from './ui/AgentGame.js';
import './ui/styles.css';
import './ui/mobile.css';
const root = document.getElementById('root');
if (!root) throw new Error('The application root is missing.');
createRoot(root).render(<AgentGame />);
