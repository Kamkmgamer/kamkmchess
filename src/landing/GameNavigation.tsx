import { useId, useSyncExternalStore } from 'react';
import {
  Icon, Book, ChessKnight, Code, Home, Information, Settings, UserAvatar,
} from '../components/quartz/icon';
import { Button } from '../components/quartz/ui/button';

export type OptionsFocus = 'modelId' | 'minutes' | 'fen' | null;

type GameNavigationProps = {
  onOptions: (focus?: OptionsFocus) => void;
  onNavigate: () => void;
  onAppearance: () => void;
};

function subscribeToSection(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function currentSection() {
  return window.location.hash || '#home';
}

/** One navigation tree for the fixed rail and the mobile drawer. */
export function GameNavigation({ onOptions, onNavigate, onAppearance }: GameNavigationProps) {
  const id = useId();
  const section = useSyncExternalStore(subscribeToSection, currentSection, () => '#home');

  return (
    <div className="sidebar-content">
      <Button className="sidebar-play" size="lg" onClick={() => onOptions('modelId')}>
        <Icon icon={ChessKnight} size={24} /><span>AI opponent</span>
      </Button>
      <nav className="game-navigation" aria-label="Chess navigation">
        <a className="sidebar-row" href="#home" aria-current={section === '#home' ? 'location' : undefined} onClick={onNavigate}>
          <Icon icon={Home} size={24} /><span>Home</span>
        </a>
        <a className="sidebar-row" href="#opening-preview" aria-current={section === '#opening-preview' ? 'location' : undefined} onClick={onNavigate}>
          <Icon icon={ChessKnight} size={24} /><span>Watch a game</span>
        </a>
        <a className="sidebar-row" href="#the-idea" aria-current={section === '#the-idea' ? 'location' : undefined} onClick={onNavigate}>
          <Icon icon={Book} size={24} /><span>How it works</span>
        </a>
      </nav>

      <div className="sidebar-bottom">
        <Button className="sidebar-row" variant="ghost" size="lg" aria-haspopup="dialog" onClick={onAppearance}>
          <Icon icon={Settings} size={20} /><span>Appearance</span>
        </Button>
        <nav className="sidebar-utilities" aria-label="About and help">
          <a className="sidebar-row" href="#questions" aria-current={section === '#questions' ? 'location' : undefined} onClick={onNavigate}>
            <Icon icon={Information} size={20} /><span>Help</span>
          </a>
          <a className="sidebar-row" href="https://github.com/Kamkmgamer/kamkmchess">
            <Icon icon={Code} size={20} /><span>Project</span>
          </a>
        </nav>
        <div className="sidebar-guest" aria-labelledby={`${id}-guest`}>
          <Icon icon={UserAvatar} size={32} />
          <div><span id={`${id}-guest`}>Guest player</span><p>Board preview</p></div>
          <Button className="sidebar-guest-settings" variant="ghost" size="lg" aria-label="Game settings" onClick={() => onOptions()}>
            <Icon icon={Settings} size={20} />
          </Button>
        </div>
      </div>
    </div>
  );
}
