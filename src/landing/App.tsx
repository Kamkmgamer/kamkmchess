import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Button } from '../components/quartz/ui/button';
import { Icon, Bot, Close, ChessKnight, SidePanelOpen } from '../components/quartz/icon';
import { useQuartzPortal } from '../lib/quartz/portal';
import { OpeningPreview } from './OpeningPreview';
import { Questions } from './Questions';
import { GameOptions } from './GameOptions';
import { HeroDither } from './HeroDither';
import { resolveHeroDitherVariant } from './hero-dither';
import { GameNavigation, type OptionsFocus } from './GameNavigation';
import { defaultSetup, defaultSetupDraft, type PreviewSetup } from './game-setup';
import { useTheme } from '../use-theme';
import { ThemeOptions } from './ThemeOptions';

type SidebarPanel = { kind: 'closed' } | { kind: 'navigation' } | { kind: 'options'; focus: OptionsFocus } | { kind: 'appearance' };

function Wordmark() {
  return (
    <a className="wordmark" href="#home" aria-label="kamkm chess home">
      <Icon icon={ChessKnight} size={24} />
      <span>kamkm chess</span>
    </a>
  );
}

export function App() {
  const theme = useTheme();
  const [panel, setPanel] = useState<SidebarPanel>({ kind: 'closed' });
  const sidebarOpen = panel.kind !== 'closed';
  const [setup, setSetup] = useState(defaultSetup);
  const [draft, setDraft] = useState(defaultSetupDraft);
  const [setupRevision, setSetupRevision] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const ditherVariant = resolveHeroDitherVariant(typeof window === 'undefined' ? '' : window.location.search);
  const portal = useQuartzPortal();
  const appliedFromDialog = useRef(false);
  const panelFocusSelector = panel.kind === 'appearance' ? 'select'
    : panel.kind === 'options' ? `[name="${panel.focus ?? 'modelId'}"]` : null;

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1001px)');
    const closeMobileSidebar = () => { if (media.matches) setPanel((current) => current.kind === 'navigation' ? { kind: 'closed' } : current); };
    media.addEventListener('change', closeMobileSidebar);
    return () => media.removeEventListener('change', closeMobileSidebar);
  }, []);

  useEffect(() => {
    // The mobile menu and settings share a popup, so changing panels needs new focus.
    if (!panelFocusSelector) return;
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(panelFocusSelector)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [panelFocusSelector]);

  function openOptions(focus: OptionsFocus = null) {
    appliedFromDialog.current = false;
    if (focus === 'fen' && draft.start.kind !== 'custom') setDraft({ ...draft, start: { kind: 'custom', fen: '' } });
    setPanel({ kind: 'options', focus });
  }

  function closeNavigation() {
    setPanel({ kind: 'closed' });
  }

  function openAppearance() {
    appliedFromDialog.current = false;
    setPanel({ kind: 'appearance' });
  }

  function applySetup(next: PreviewSetup) {
    appliedFromDialog.current = sidebarOpen;
    setSetup(next);
    setSetupRevision((revision) => revision + 1);
    setPanel({ kind: 'closed' });
    // Wait for the updated board before moving focus; the modal restores it here too.
    requestAnimationFrame(() => {
      previewRef.current?.scrollIntoView({ block: 'start' });
      previewRef.current?.focus({ preventScroll: true });
    });
  }

  return (
    <Dialog.Root open={sidebarOpen} onOpenChange={(open) => { if (!open) closeNavigation(); }}>
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="game-sidebar" aria-label="Main sidebar">
        <Wordmark />
        <GameNavigation onOptions={openOptions} onNavigate={closeNavigation} onAppearance={openAppearance} />
      </aside>
      <Button className="mobile-menu-trigger" variant="secondary" size="icon-lg" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={panel.kind === 'navigation'} onClick={() => { appliedFromDialog.current = false; setPanel({ kind: 'navigation' }); }}>
        <Icon icon={SidePanelOpen} size={24} />
      </Button>

      <main id="main" className="site-main">
        {/* The home anchor stays in document flow while the hero sticks. */}
        <div id="home" className="hero-anchor" />
        <section className="hero" aria-labelledby="hero-heading">
          <div className="hero-media" aria-hidden="true">
            <img
              src="/images/hero-options/01-knight-vs-models.png"
              width={1672}
              height={941}
              alt=""
              fetchPriority="high"
              decoding="async"
            />
            <HeroDither className="hero-dither" variant={ditherVariant} />
          </div>
          <div className="hero-introduction page-width">
            <h1 id="hero-heading">Chess against a<br />different mind.</h1>
            <p>Play against AI models that choose their own moves.<br className="desktop-break" /> A familiar game, with a new kind of opponent.</p>
            <Button size="lg" render={<a href="/play" />} nativeButton={false} role="link">Play against AI</Button>
          </div>
        </section>

        <div className="page-sections">
          <section id="the-idea" className="idea-section" aria-labelledby="idea-heading">
            <div className="idea-layout page-width">
              <div className="idea-heading">
                <h2 id="idea-heading">Choose your<br />AI opponent.</h2>
                <p>Connect your provider or proxy, choose an available model, and start a match.</p>
                <Button className="section-action" size="lg" render={<a href="/play" />} nativeButton={false} role="link"><Icon icon={Bot} size={24} />Choose AI model</Button>
              </div>
              <figure className="opponent-study">
                <img src="/images/model-opponents.jpg" alt="An ivory knight faces a lineup of black chess sculptures crowned with AI model marks." width={1672} height={941} loading="lazy" decoding="async" />
              </figure>
            </div>
          </section>

          <div className="preview-focus-target" ref={previewRef} tabIndex={-1} aria-label="Board preview">
            <OpeningPreview key={setupRevision} setup={setup} onOptions={() => openOptions()} />
          </div>

          <Questions />
          <footer className="site-footer">
            <div className="footer-top page-width">
              <div>
                <a className="footer-brand" href="#home">kamkm chess</a>
                <p>Built by two friends. Still taking shape.</p>
              </div>
              <div className="footer-actions">
                <Button variant="secondary" size="lg" render={<a href="/play" />} nativeButton={false} role="link">Play against AI</Button>
                <a href="#home">Back to the top</a>
              </div>
            </div>
            <div className="footer-bottom page-width">
              <span>© {new Date().getFullYear()} kamkm chess</span>
              <span>Chess imagery created with AI.</span>
            </div>
          </footer>
        </div>
      </main>

      <Dialog.Portal {...(portal ? { container: portal } : {})}>
        <Dialog.Backdrop className="sidebar-backdrop" />
        {/* Each panel needs its own focus manager when replacing the mobile menu. */}
        <Dialog.Popup key={panel.kind} ref={panelRef} className={`sidebar-panel${panel.kind === 'navigation' ? ' sidebar-panel-navigation' : ''}`} initialFocus={() => panelFocusSelector ? panelRef.current?.querySelector<HTMLElement>(panelFocusSelector) ?? true : true} finalFocus={() => appliedFromDialog.current ? previewRef.current : true}>
          <div className="mobile-sidebar-heading">
            <Dialog.Title>{panel.kind === 'navigation' ? 'kamkm chess' : panel.kind === 'appearance' ? 'Appearance' : 'Preview options'}</Dialog.Title>
            <Dialog.Close render={<Button variant="ghost" size="icon-lg" aria-label="Close menu" />}><Icon icon={Close} /></Dialog.Close>
          </div>
          <Dialog.Description className="visually-hidden">{panel.kind === 'navigation' ? 'Explore chess, set up a game or find help.' : panel.kind === 'appearance' ? 'Choose a theme and light, dark or system appearance.' : 'Choose your side, clocks, opponent label and starting position for the board preview.'}</Dialog.Description>
          {panel.kind === 'navigation'
            ? <GameNavigation onOptions={openOptions} onNavigate={closeNavigation} onAppearance={openAppearance} />
            : panel.kind === 'appearance' ? <ThemeOptions {...theme} />
              : <GameOptions draft={draft} onDraftChange={setDraft} onApply={applySetup} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
