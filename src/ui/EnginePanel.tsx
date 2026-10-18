import { useEffect, useRef, useState } from 'react';
import type { ModelSelection } from '../controller/index.js';
import { createEngineSelection, engineSettings, recommendEngine } from '../engines/local.js';
import { BROWSER_ENGINES, downloadBrowserEngine, searchBrowserEngine, supportsBrowserEngines } from '../engines/browser.js';
import type { BrowserEngineId, BrowserEngineSettings, EngineProgress } from '../engines/browser.js';
import { IconButton } from './Icon.js';

interface Props { readonly label: string; readonly selected: ModelSelection | null; readonly onSelect: (selection: ModelSelection | null) => void; }
const TEST_POSITION = { startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: [] };
export function EnginePanel({ label, selected, onSelect }: Props) {
  const [settings, setSettings] = useState<BrowserEngineSettings>(() => selected ? engineSettings(selected) : recommendEngine({ logicalCores: navigator.hardwareConcurrency || 2, memoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null }));
  const [advanced, setAdvanced] = useState(false);
  const [progress, setProgress] = useState<EngineProgress | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const callback = useRef(onSelect);
  useEffect(() => { callback.current = onSelect; }, [onSelect]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      callback.current(null); setState('loading'); setProgress(null);
      void (async () => {
        if (!supportsBrowserEngines()) throw new Error('Unsupported browser');
        await downloadBrowserEngine(settings.engineId, progress => { if (!controller.signal.aborted) setProgress(progress); }, controller.signal);
        await searchBrowserEngine({ ...settings, moveTimeMs: 250 }, TEST_POSITION, controller.signal);
        if (controller.signal.aborted) return;
        callback.current(createEngineSelection(settings)); setState('ready'); setProgress(null);
      })().catch(() => { if (!controller.signal.aborted) { setState('failed'); setProgress(null); } });
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [settings, attempt]);
  function change(next: BrowserEngineSettings) { callback.current(null); setState('loading'); setSettings(next); }
  return <section className="engine-setup" aria-label={label} aria-busy={state === 'loading'}>
    <div className="panel-heading"><h2>{advanced ? 'Memory' : 'Engine'}</h2><IconButton icon={advanced ? 'back' : 'settings'} label={advanced ? 'Back' : 'Engine memory'} onClick={() => setAdvanced(value => !value)} /></div>
    <div className="connection-form">
      {advanced ? <label className="sr-label">Hash memory<select aria-label="Hash memory" value={settings.hashMb} onChange={event => change({ ...settings, hashMb: Number(event.target.value) })}>{[16, 32, 64, 128, 256].map(size => <option key={size} value={size}>{size}MB</option>)}</select></label> : <>
        <label className="sr-label">Chess engine<select aria-label="Chess engine" value={settings.engineId} onChange={event => change({ ...settings, engineId: event.target.value as BrowserEngineId })}>{(Object.keys(BROWSER_ENGINES) as BrowserEngineId[]).map(id => <option key={id} value={id}>{BROWSER_ENGINES[id].name}</option>)}</select></label>
        <label>Time<select aria-label="Thinking time per move" value={settings.moveTimeMs} onChange={event => change({ ...settings, moveTimeMs: Number(event.target.value) })}><option value="250">0.25s</option><option value="1000">1s</option><option value="3000">3s</option><option value="10000">10s</option></select></label>
      </>}
      {progress?.phase === 'downloading' && <progress aria-label="Engine download" value={progress.loaded} max={progress.total} />}
      <p role="status">{state === 'ready' ? 'Ready' : state === 'failed' ? supportsBrowserEngines() ? 'Couldn’t start.' : 'Unsupported browser.' : progress?.phase === 'downloading' ? 'Downloading…' : 'Preparing…'}</p>
      {state === 'failed' && <button className="button secondary" onClick={() => setAttempt(value => value + 1)}>Retry</button>}
    </div>
  </section>;
}
