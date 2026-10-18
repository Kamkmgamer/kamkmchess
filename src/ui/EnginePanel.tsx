import { useEffect, useRef, useState } from 'react';
import type { ModelSelection } from '../controller/index.js';
import { createEngineSelection, engineSettings, recommendEngine } from '../engines/local.js';
import { BROWSER_ENGINES, downloadBrowserEngine, isEngineDownloaded, searchBrowserEngine, supportsBrowserEngines } from '../engines/browser.js';
import type { BrowserEngineId, BrowserEngineSettings, EngineProgress } from '../engines/browser.js';

interface Props {
  readonly label: string;
  readonly selected: ModelSelection | null;
  readonly onSelect: (selection: ModelSelection | null) => void;
}
const TEST_POSITION = { startingFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: [] };

export function EnginePanel({ label, selected, onSelect }: Props) {
  const [computer] = useState(() => ({ logicalCores: navigator.hardwareConcurrency || 2,
    memoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null }));
  const recommendation = recommendEngine(computer);
  const [settings, setSettings] = useState<BrowserEngineSettings>(() => selected ? engineSettings(selected) : recommendation);
  const [downloaded, setDownloaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<EngineProgress | null>(null);
  const [message, setMessage] = useState('');
  const abort = useRef<AbortController | null>(null);
  const capable = supportsBrowserEngines();
  const engine = BROWSER_ENGINES[settings.engineId];
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    let current = true;
    void isEngineDownloaded(settings.engineId).then(ready => { if (current) setDownloaded(ready); });
    return () => { current = false; };
  }, [settings.engineId]);
  function changeSettings(next: BrowserEngineSettings) { setSettings(next); onSelect(null); setMessage(''); setProgress(null); }
  async function prepare() {
    setBusy(true); setMessage(''); onSelect(null);
    const controller = new AbortController(); abort.current = controller;
    try {
      const source = await downloadBrowserEngine(settings.engineId, setProgress, controller.signal);
      setDownloaded(true); setProgress({ phase: 'starting', loaded: 1, total: 1 });
      const result = await searchBrowserEngine({ ...settings, moveTimeMs: 250 }, TEST_POSITION, controller.signal);
      if (controller.signal.aborted) return;
      onSelect(createEngineSelection(settings));
      setMessage(`Ready. Test move completed in ${(result.elapsedMs / 1000).toFixed(2)} seconds. ${source.cached ? 'Engine saved in this browser for future games.' : 'Engine ready for this session. This browser could not keep a persistent copy.'}`);
    } catch (error) { setMessage(controller.signal.aborted ? 'Download or engine check cancelled. You can try again.' : error instanceof Error ? error.message : 'The engine could not start. Try Stockfish Lite.'); }
    finally { if (abort.current === controller) { setBusy(false); setProgress(null); abort.current = null; } }
  }
  return <section className="engine-setup" aria-label={label}>
    <div className="panel-heading"><h3>{label}</h3><span className="muted">Runs in your browser</span></div>
    <p className="muted">Recommended for this device: {BROWSER_ENGINES[recommendation.engineId].name}. {computer.logicalCores} logical CPU cores reported{computer.memoryGb === null ? '; memory information is unavailable' : `; about ${computer.memoryGb} GB memory reported`}. Recommendations are estimates; the engine checks itself before play.</p>
    <div className="setup-form">
      <label>Chess engine<select value={settings.engineId} disabled={busy || !capable} onChange={event => changeSettings({ ...settings, engineId: event.target.value as BrowserEngineId })}>
        {(Object.keys(BROWSER_ENGINES) as BrowserEngineId[]).map(id => <option key={id} value={id}>{BROWSER_ENGINES[id].name}{id === recommendation.engineId ? ' (recommended)' : ''}</option>)}
        <option value="lc0" disabled>Leela Chess Zero · Coming soon</option>
      </select></label>
      <label>Thinking time per move<select value={settings.moveTimeMs} disabled={busy} onChange={event => changeSettings({ ...settings, moveTimeMs: Number(event.target.value) })}>
        <option value="250">0.25 seconds</option><option value="1000">1 second</option><option value="3000">3 seconds</option><option value="10000">10 seconds</option>
      </select></label>
    </div>
    <p>{engine.description} {downloaded ? 'Already downloaded in this browser.' : `About ${engine.downloadMb} MB, downloaded once when you select it.`} Moves are calculated on your device.</p>
    <p className="muted">One background CPU thread keeps the interface responsive. Lower thinking time uses less battery. Leela's browser integration is coming soon.</p>
    <details className="engine-instructions"><summary>Engine memory</summary>
      <label className="engine-memory">Hash memory<select value={settings.hashMb} disabled={busy} onChange={event => changeSettings({ ...settings, hashMb: Number(event.target.value) })}>
        {[16, 32, 64, 128, 256].map(size => <option key={size} value={size}>{size} MB</option>)}
      </select></label>
      <p className="muted">Recommended hash: {recommendation.hashMb} MB. Total engine memory also includes its evaluation network and WebAssembly runtime. Stockfish Lite uses less memory.</p>
    </details>
    <div className="engine-actions">
      <button className="button secondary" type="button" disabled={busy || !capable} onClick={() => void prepare()}>{busy ? progress?.phase === 'downloading' ? 'Downloading engine…' : 'Starting engine…' : selected ? 'Recheck engine' : downloaded ? 'Use engine' : 'Download and use engine'}</button>
      {busy && <button className="button quiet" type="button" onClick={() => abort.current?.abort()}>Cancel</button>}
    </div>
    {progress?.phase === 'downloading' && <div className="engine-download"><progress aria-label="Engine download" value={progress.loaded} max={progress.total} /><span>{(progress.loaded / 1_000_000).toFixed(1)} / {(progress.total / 1_000_000).toFixed(1)} MB</span></div>}
    {!capable && <p className="error-message">This browser cannot run WebAssembly engines. Use a current version of Chrome, Edge, Firefox or Safari.</p>}
    {message && <p className="engine-status" role="status">{message}</p>}
    {selected && <p className="engine-ready">Engine ready for this match.</p>}
  </section>;
}
