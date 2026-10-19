import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Icon, IconButton } from '../ui/Icon';
import { clampSidebarWidth, readSidebarPreferences, saveSidebarPreferences, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './sidebar-preferences';
import './right-game-sidebar.css';

interface Props {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly showReopenButton?: boolean;
  readonly children: (close: () => void) => ReactNode;
}

const MOBILE_QUERY = '(max-width: 760px), (max-width: 1000px) and (max-height: 500px)';

function subscribeToMobile(onChange: () => void) {
  const media = window.matchMedia(MOBILE_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/** The real game configuration lives in the existing right-hand drawer. */
export function RightGameSidebar({ open, onOpenChange, showReopenButton = true, children }: Props) {
  const [width, setWidth] = useState(() => readSidebarPreferences().width);
  const mobile = useSyncExternalStore(subscribeToMobile, () => window.matchMedia(MOBILE_QUERY).matches, () => false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    wasOpen.current = open;
    saveSidebarPreferences({ width, collapsed: !open });
  }, [open, width]);

  function changeOpen(next: boolean) {
    saveSidebarPreferences({ width, collapsed: !next });
    onOpenChange(next);
  }
  function resize(next: number) { setWidth(clampSidebarWidth(next)); }

  return <Dialog.Root modal={mobile} open={open} onOpenChange={changeOpen}>
    {!open && showReopenButton && <button className="game-options-reopen" type="button" aria-label="Expand game settings" title="Expand game settings" onClick={() => changeOpen(true)}><Icon name="settings" /></button>}
    <Dialog.Portal>
      {mobile && <Dialog.Backdrop className="game-options-backdrop" />}
      <Dialog.Popup className="right-game-sidebar" aria-hidden={open ? undefined : true} inert={!open} style={{ '--game-options-width': `${width}px` } as CSSProperties}
        initialFocus={() => document.getElementById('game-mode') ?? true} finalFocus={() => returnFocus.current?.isConnected ? returnFocus.current : false}>
        <header className="game-options-heading"><Dialog.Title>New game</Dialog.Title><IconButton icon="close" label="Close" title="Collapse game settings" onClick={() => changeOpen(false)} /></header>
        <Dialog.Description className="game-options-sr-only">Configure the players, time control and starting position, then start a real match.</Dialog.Description>
        <div className="game-options-body">{children(() => changeOpen(false))}</div>
        {!mobile && <div className="game-options-resizer" role="separator" aria-label="Game settings width" aria-orientation="vertical" tabIndex={0}
          aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuemax={SIDEBAR_MAX_WIDTH} aria-valuenow={width} aria-valuetext={`${width} pixels`}
          title="Drag or use arrow keys to resize. Double-click to reset."
          onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(window.innerWidth - event.clientX); }}
          onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onDoubleClick={() => resize(SIDEBAR_DEFAULT_WIDTH)}
          onKeyDown={event => {
            const next = event.key === 'ArrowLeft' ? width + (event.shiftKey ? 32 : 8) : event.key === 'ArrowRight' ? width - (event.shiftKey ? 32 : 8)
              : event.key === 'Home' ? SIDEBAR_MIN_WIDTH : event.key === 'End' ? SIDEBAR_MAX_WIDTH : event.key === 'Enter' ? SIDEBAR_DEFAULT_WIDTH : null;
            if (next !== null) { event.preventDefault(); resize(next); }
          }} />}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
