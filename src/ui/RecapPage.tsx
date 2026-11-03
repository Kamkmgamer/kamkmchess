import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameReplay } from '../review/replay.js';
import { reviewGame } from '../review/review.js';
import type { GameReview, ReviewProgress } from '../review/review.js';
import { planRecap, sceneAt } from '../recap/timeline.js';
import type { RecapMode } from '../recap/timeline.js';
import { scheduleMusic } from '../recap/music.js';
import { exportRecap } from '../video/export.js';
import type { ExportProgress, ExportResult } from '../video/export.js';
import { prepareRenderAssets, renderFrame, VIDEO_HEIGHT, VIDEO_WIDTH } from '../video/render.js';
import type { RenderAssets } from '../video/render.js';
import type { BoardStyle } from './board-style.js';
import type { PieceStyle } from './piece-style.js';
import { IconButton } from './Icon.js';
import './recap-page.css';

export interface RecapInput {
  readonly replay: GameReplay;
  readonly boardStyle: BoardStyle;
  readonly pieceStyle: PieceStyle;
  readonly orientation: 'white' | 'black';
}

function clock(seconds: number): string { return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function failure(error: unknown): string { return error instanceof Error ? error.message : 'The video could not finish. Retry.'; }

export default function RecapPage({ input, onClose }: { readonly input: RecapInput; readonly onClose: () => void }) {
  const [review, setReview] = useState<GameReview | null>(null);
  const [assets, setAssets] = useState<RenderAssets | null>(null);
  const [phase, setPhase] = useState<'reviewing' | 'ready' | 'exporting' | 'done' | 'error' | 'stopped'>('reviewing');
  const [reviewProgress, setReviewProgress] = useState<ReviewProgress | null>(null);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<RecapMode>(input.replay.moves.length > 70 ? 'highlights' : 'replay');
  const [orientation, setOrientation] = useState(input.orientation);
  const [volume, setVolume] = useState(0.65);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<{ url: string; name: string; blob: Blob } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const cursor = useRef(0);
  const job = useRef<AbortController | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const exported = useRef<ExportResult | null>(null);
  const downloadUrl = useRef<string | null>(null);
  const alive = useRef(false);
  const timeline = useMemo(() => review ? planRecap(review, mode) : null, [review, mode]);
  const activeScene = timeline ? sceneAt(timeline, time) : null;
  const busy = phase === 'reviewing' || phase === 'exporting';

  useEffect(() => {
    alive.current = true;
    heading.current?.focus();
    return () => {
      alive.current = false; job.current?.abort();
      void audio.current?.close().catch(() => undefined);
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      void exported.current?.release();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    job.current = controller;
    void (async () => {
      try {
        const result = await reviewGame(input.replay, controller.signal, progress => { if (!controller.signal.aborted) setReviewProgress(progress); });
        const ready = await prepareRenderAssets(planRecap(result), input.boardStyle, input.pieceStyle, controller.signal);
        if (controller.signal.aborted) return;
        setReview(result); setAssets(ready); setPhase('ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(failure(error)); setPhase('error');
      }
    })();
    return () => controller.abort();
  }, [input, attempt]);

  useEffect(() => {
    if (!playing && timeline && assets && canvas.current) renderFrame(canvas.current, timeline, time, assets, orientation);
  }, [timeline, assets, time, orientation, playing]);

  useEffect(() => {
    if (!playing || !timeline || !assets) return;
    const context = audio.current;
    const offset = cursor.current >= timeline.duration ? 0 : cursor.current;
    const began = performance.now();
    const audioStart = (context?.currentTime ?? 0) + 0.02;
    if (context) scheduleMusic(context, context.destination, timeline, { offset, at: audioStart, duration: timeline.duration - offset, volume });
    let frame = 0;
    const draw = () => {
      const elapsed = context ? Math.max(0, context.currentTime - audioStart) : (performance.now() - began) / 1000;
      const next = Math.min(timeline.duration, offset + elapsed);
      cursor.current = next;
      if (canvas.current) renderFrame(canvas.current, timeline, next, assets, orientation);
      setTime(next);
      if (next >= timeline.duration) setPlaying(false);
      else frame = requestAnimationFrame(draw);
    };
    const hide = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener('visibilitychange', hide);
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', hide);
      void context?.close().catch(() => undefined);
      if (audio.current === context) audio.current = null;
    };
  }, [playing, timeline, assets, orientation, volume]);

  function clearDownload(): void {
    if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
    downloadUrl.current = null; setDownload(null);
    void exported.current?.release(); exported.current = null;
  }
  function seek(next: number): void { setPlaying(false); cursor.current = next; setTime(next); }
  async function play(): Promise<void> {
    if (playing) { setPlaying(false); return; }
    try {
      setError(null);
      if (volume > 0) {
        const context = new AudioContext(); audio.current = context; await context.resume();
        if (!alive.current) { await context.close(); return; }
      }
      setPlaying(true);
    } catch { setError('Audio could not start. Retry playback or mute Music.'); }
  }
  async function makeVideo(): Promise<void> {
    if (!timeline || !assets || busy) return;
    setPlaying(false); clearDownload(); setError(null); setPhase('exporting'); setExportProgress(null);
    const controller = new AbortController(); job.current = controller;
    try {
      const result = await exportRecap(timeline, assets, orientation, volume, controller.signal,
        value => { if (!controller.signal.aborted) setExportProgress(value); });
      if (controller.signal.aborted || !alive.current) { await result.release(); return; }
      exported.current = result;
      const url = URL.createObjectURL(result.blob); downloadUrl.current = url;
      setDownload({ url, name: `chess-${input.replay.gameId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}.${result.extension}`, blob: result.blob });
      setPhase('done');
    } catch (error) {
      if (controller.signal.aborted || !alive.current) return;
      setError(failure(error)); setPhase('error');
    }
  }
  function cancel(): void {
    job.current?.abort(); setPlaying(false); setPhase(review && assets ? 'ready' : 'stopped');
  }
  function retry(): void { setError(null); setPhase('reviewing'); setAttempt(value => value + 1); }
  function changeMode(next: RecapMode): void { seek(0); clearDownload(); setMode(next); if (review) setPhase('ready'); }
  async function share(): Promise<void> {
    if (!download) return;
    try { await navigator.share({ files: [new File([download.blob], download.name, { type: download.blob.type })] }); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) setError('Sharing failed. Download the video instead.'); }
  }
  const percentage = phase === 'exporting' && exportProgress ? exportProgress.completed / Math.max(1, exportProgress.total)
    : reviewProgress?.download ?? (reviewProgress ? reviewProgress.completed / Math.max(1, reviewProgress.total) : 0);
  const progressLabel = phase === 'exporting' ? exportProgress?.phase === 'recording' ? 'Recording. Keep this tab visible.'
    : exportProgress?.phase === 'finishing' ? 'Finishing video' : 'Encoding video'
    : reviewProgress?.download !== null && reviewProgress?.download !== undefined ? 'Downloading engine' : 'Reviewing moves';
  const canShare = download !== null && typeof navigator.canShare === 'function'
    && navigator.canShare({ files: [new File([download.blob], download.name, { type: download.blob.type })] });

  return <section className="focus-page recap-page" aria-label="Game video">
    <div className="panel-heading recap-heading"><h2 ref={heading} tabIndex={-1}>Game video</h2><IconButton icon="close" label="Close video" onClick={onClose} /></div>
    <div className="recap-layout">
      <div className="recap-stage" aria-busy={busy}>
        {assets && timeline ? <canvas ref={canvas} width={VIDEO_WIDTH} height={VIDEO_HEIGHT} className="recap-canvas"
          role="img" aria-label={activeScene?.move ? `${activeScene.move.label}. ${activeScene.caption}. ${activeScene.move.explanation}` : activeScene?.caption ?? 'Game recap'} />
          : <div className="recap-waiting"><div className="recap-board-mark" aria-hidden="true" /><p>{phase === 'stopped' ? 'Review paused' : phase === 'error' ? 'Review unavailable' : 'Reviewing your game'}</p></div>}
      </div>
      <div className="recap-controls">
        {busy && <div className="recap-progress" role="status" aria-live="polite">
          <p>{progressLabel}</p><progress value={percentage} max={1} aria-label={progressLabel} />
          <div className="recap-progress-detail"><span>{phase === 'reviewing' ? reviewProgress?.engine ?? 'Stockfish' : `${Math.round(percentage * 100)}%`}</span>
            {phase === 'reviewing' && <span>{reviewProgress?.completed ?? 0}/{input.replay.moves.length}</span>}</div>
          <button className="button secondary" type="button" onClick={cancel}>Cancel</button>
        </div>}
        {error && <p className="recap-error" role="alert">{error}</p>}
        {!review && !busy && <button className="button primary" type="button" onClick={retry}>{phase === 'stopped' ? 'Continue review' : 'Retry review'}</button>}
        {timeline && assets && <>
          <div className="recap-transport">
            <IconButton icon={playing ? 'stop' : 'play'} label={playing ? 'Pause preview' : 'Play preview'} onClick={() => void play()} disabled={busy} />
            <input type="range" min={0} max={timeline.duration} step={0.1} value={time} disabled={busy} aria-label="Video position" onChange={event => seek(Number(event.target.value))} />
            <output>{clock(time)} / {clock(timeline.duration)}</output>
          </div>
          <fieldset className="recap-mode" disabled={busy}><legend>Include</legend>
            <label><input type="radio" name="recap-mode" checked={mode === 'replay'} onChange={() => changeMode('replay')} />Full game</label>
            <label><input type="radio" name="recap-mode" checked={mode === 'highlights'} onChange={() => changeMode('highlights')} />Highlights</label>
          </fieldset>
          <label className="recap-volume">Music<input type="range" min={0} max={1} step={0.05} value={volume} aria-label="Music volume" aria-valuetext={volume === 0 ? 'Muted' : `${Math.round(volume * 100)}%`} disabled={busy}
            onChange={event => { setPlaying(false); clearDownload(); setVolume(Number(event.target.value)); }} /></label>
          <div className="recap-export-actions">
            <IconButton icon="flip" label="Flip video board" disabled={busy} onClick={() => { setPlaying(false); clearDownload(); setOrientation(side => side === 'white' ? 'black' : 'white'); }} />
            {!busy && <button className="button primary" type="button" onClick={() => void makeVideo()}>Export video</button>}
          </div>
          {download && <div className="recap-download"><a className="button primary" href={download.url} download={download.name}>Download video</a>
            {canShare && <button className="button secondary" type="button" onClick={() => void share()}>Share</button>}</div>}
        </>}
      </div>
    </div>
  </section>;
}
