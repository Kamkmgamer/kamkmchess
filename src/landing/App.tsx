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

type SidebarPanel = { kind: 'closed' } | { kind: 'navigation' } | { kind: 'options'; focus: OptionsFocus };

function Wordmark() {
  return (
    <a className="wordmark" href="#home" aria-label="kamkm chess home">
      <Icon icon={ChessKnight} size={24} />
      <span>kamkm chess</span>
    </a>
  );
}

export function App() {
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

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1001px)');
    const closeMobileSidebar = () => { if (media.matches) setPanel((current) => current.kind === 'navigation' ? { kind: 'closed' } : current); };
    media.addEventListener('change', closeMobileSidebar);
    return () => media.removeEventListener('change', closeMobileSidebar);
  }, []);

  useEffect(() => {
    if (panel.kind !== 'options') return;
    // The mobile menu and options share a popup, so moving between them needs new focus.
    const field = panel.focus ?? 'modelId';
    const frame = requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(`[name="${field}"]`)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [panel]);

  function openOptions(focus: OptionsFocus = null) {
    appliedFromDialog.current = false;
    if (focus === 'fen' && draft.start.kind !== 'custom') setDraft({ ...draft, start: { kind: 'custom', fen: '' } });
    setPanel({ kind: 'options', focus });
  }

  function closeNavigation() {
    setPanel({ kind: 'closed' });
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
      <aside className="game-sidebar" data-surface="ink" aria-label="Main sidebar">
        <Wordmark />
        <GameNavigation onOptions={openOptions} onNavigate={closeNavigation} />
      </aside>
      <Button className="mobile-menu-trigger" variant="secondary" size="icon-lg" aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={panel.kind === 'navigation'} onClick={() => { appliedFromDialog.current = false; setPanel({ kind: 'navigation' }); }}>
        <Icon icon={SidePanelOpen} size={24} />
      </Button>

      <main id="main" className="site-main">
        {/* The home anchor stays in document flow while the hero sticks. */}
        <div id="home" className="hero-anchor" />
        <section className="hero" data-surface="ink" aria-labelledby="hero-heading">
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
            <Button size="lg" onClick={() => openOptions()}>Set up your game</Button>
          </div>
        </section>

        <div className="page-sections" data-surface="ink">
          <section id="the-idea" className="idea-section" aria-labelledby="idea-heading">
            <div className="idea-layout page-width">
              <div className="idea-heading">
                <h2 id="idea-heading">Choose your<br />AI opponent.</h2>
                <p>We’re building chess against language models, each choosing its own moves. Choose a model for your board preview.</p>
                <Button className="section-action" size="lg" onClick={() => openOptions('modelId')}><Icon icon={Bot} size={24} />Choose AI model</Button>
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
                <Button variant="secondary" size="lg" onClick={() => openOptions()}>Set up your game</Button>
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
        <Dialog.Popup ref={panelRef} className={`sidebar-panel${panel.kind === 'navigation' ? ' sidebar-panel-navigation' : ''}`} {...(panel.kind === 'navigation' ? { 'data-surface': 'ink' } : {})} initialFocus={() => panel.kind === 'options' && panel.focus ? panelRef.current?.querySelector<HTMLElement>(`[name="${panel.focus}"]`) ?? true : true} finalFocus={() => appliedFromDialog.current ? previewRef.current : true}>
          <div className="mobile-sidebar-heading">
            <Dialog.Title>{panel.kind === 'navigation' ? 'kamkm chess' : 'Game options'}</Dialog.Title>
            <Dialog.Close render={<Button variant="ghost" size="icon-lg" aria-label="Close menu" />}><Icon icon={Close} /></Dialog.Close>
          </div>
          <Dialog.Description className="visually-hidden">{panel.kind === 'navigation' ? 'Explore chess, set up a game or find help.' : 'Choose your side, time control, model ID and starting position for the board preview.'}</Dialog.Description>
          {panel.kind === 'navigation'
            ? <GameNavigation onOptions={openOptions} onNavigate={closeNavigation} />
            : <GameOptions draft={draft} onDraftChange={setDraft} onApply={applySetup} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
