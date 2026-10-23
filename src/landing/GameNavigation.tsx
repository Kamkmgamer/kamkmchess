import { useId, useSyncExternalStore } from 'react';
import {
  Icon, Book, ChessKnight, Code, Home, Information, Settings, UserAvatar,
} from '../components/quartz/icon';
import { Button } from '../components/quartz/ui/button';
import type { AccountControlsState } from '../accounts/account-controls';

export type OptionsFocus = 'modelId' | 'minutes' | 'fen' | null;

type GameNavigationProps = {
  onOptions: (focus?: OptionsFocus) => void;
  onNavigate: () => void;
  onAppearance: () => void;
  account: AccountControlsState;
  onAccount: () => void;
};

function subscribeToSection(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function currentSection() {
  return window.location.hash || '#home';
}

/** One navigation tree for the fixed rail and the mobile drawer. */
export function GameNavigation({ onOptions, onNavigate, onAppearance, account, onAccount }: GameNavigationProps) {
  const id = useId();
  const section = useSyncExternalStore(subscribeToSection, currentSection, () => '#home');
  const accountLabel = account.status === 'loading' ? 'Loading account' : account.status === 'error' ? 'Retry account' : account.user ? 'Account settings' : 'Sign in';
  const accountDescription = account.user ? account.user.email ?? 'Signed in'
    : account.status === 'disabled' ? 'Playing locally' : account.status === 'loading' ? 'Loading account...' : 'Sign in';

  return (
    <div className="sidebar-content">
      <Button className="sidebar-play" size="lg" onClick={() => onOptions('modelId')}>
        <Icon icon={ChessKnight} size={20} /><span>AI opponent</span>
      </Button>
      <nav className="game-navigation" aria-label="Chess navigation">
        <a className="sidebar-row" href="#home" aria-current={section === '#home' ? 'location' : undefined} onClick={onNavigate}>
          <Icon icon={Home} size={20} /><span>Home</span>
        </a>
        <a className="sidebar-row" href="#opening-preview" aria-current={section === '#opening-preview' ? 'location' : undefined} onClick={onNavigate}>
          <Icon icon={ChessKnight} size={20} /><span>Watch a game</span>
        </a>
        <a className="sidebar-row" href="#the-idea" aria-current={section === '#the-idea' ? 'location' : undefined} onClick={onNavigate}>
          <Icon icon={Book} size={20} /><span>How it works</span>
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
          <a className="sidebar-row" href="https://github.com/Kamkmgamer/kamkmchess" target="_blank" rel="noopener noreferrer">
            <Icon icon={Code} size={20} /><span>Project</span>
          </a>
        </nav>
        <div className="sidebar-guest" aria-labelledby={`${id}-guest`}>
          {account.user?.imageUrl
            ? <img className="sidebar-account-avatar" src={account.user.imageUrl} alt="" width={32} height={32} referrerPolicy="no-referrer" />
            : <Icon icon={UserAvatar} size={32} />}
          <div className="sidebar-account-identity">
            <span id={`${id}-guest`} title={account.user?.name}>{account.user?.name ?? 'Guest player'}</span>
            <p title={account.user?.email ?? undefined}>{accountDescription}</p>
          </div>
          <Button className="sidebar-guest-settings" variant="ghost" size="lg"
            aria-label={account.status === 'disabled' ? 'Account settings' : accountLabel}
            title={account.status === 'disabled' ? 'Account sign-in is unavailable' : accountLabel}
            aria-haspopup="dialog" disabled={account.status === 'disabled' || account.status === 'loading' || account.busy} onClick={onAccount}>
            <Icon icon={Settings} size={20} />
          </Button>
        </div>
        {account.message && <p className="sidebar-account-message" role="status">{account.message}</p>}
      </div>
    </div>
  );
}
