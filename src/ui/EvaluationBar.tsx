import { useEffect, useRef, useState } from 'react';
import { BROWSER_ENGINES } from '../engines/browser.js';
import { PositionEvaluator } from '../engines/evaluation.js';
import { formatEvaluation, whiteEvaluationPercent } from '../engines/uci-score.js';
import type { EngineEvaluation } from '../engines/uci-score.js';

interface EvaluationState { key: string; evaluation?: EngineEvaluation; engine?: string; status: string; failed?: boolean }

export function EvaluationBar({ startingFen, moves, orientation }: {
  readonly startingFen: string; readonly moves: string; readonly orientation: 'white' | 'black';
}) {
  const evaluator = useRef<PositionEvaluator | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<EvaluationState | null>(null);
  const key = `${startingFen}|${moves}`;
  useEffect(() => {
    const service = new PositionEvaluator(); evaluator.current = service;
    return () => { service.close(); evaluator.current = null; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // Debounce history scrubbing without tying analysis to clock ticks or archive updates.
    const timer = window.setTimeout(() => {
      void evaluator.current?.evaluate({ startingFen, moves: moves ? moves.split(' ') : [] }, controller.signal,
        (evaluation, id) => setState({ key, evaluation, engine: BROWSER_ENGINES[id].name, status: `Depth ${evaluation.depth}` }),
        (id, progress) => setState({ key, engine: BROWSER_ENGINES[id].name, status: progress?.phase === 'downloading'
          ? `Downloading ${Math.min(100, Math.round(progress.loaded / progress.total * 100))}%` : 'Analyzing' }),
      ).catch(() => {
        if (!controller.signal.aborted) setState({ key, status: 'Evaluation unavailable. Click to retry.', failed: true });
      });
    }, 100);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [startingFen, moves, key, attempt]);
  const current = state?.key === key ? state : null;
  const score = current?.evaluation?.score;
  const percent = score ? whiteEvaluationPercent(score) : 50;
  const label = score ? formatEvaluation(score) : current?.failed ? '!' : '…';
  const description = [current?.engine, score ? `White evaluation ${label}` : 'Position evaluation', current?.status ?? 'Preparing analysis'].filter(Boolean).join('. ');
  const whiteFavored = score?.kind === 'mate' ? score.winner === 'white' : (score?.value ?? 0) >= 0;
  const labelAtBottom = whiteFavored === (orientation === 'white');
  return <button type="button" className={`evaluation-bar ${orientation === 'black' ? 'reversed' : ''} ${score ? '' : 'pending'}`}
    aria-label={description} title={description} aria-disabled={!current?.failed}
    data-engine={current?.engine} data-state={current?.failed ? 'failed' : score ? 'ready' : 'loading'}
    onClick={() => { if (current?.failed) setAttempt(value => value + 1); }}>
    <span className="evaluation-white" style={{ transform: `scaleY(${percent / 100})` }} />
    <span className="evaluation-midpoint" />
    <span className={`evaluation-score ${whiteFavored ? 'for-white' : 'for-black'} ${labelAtBottom ? 'at-bottom' : 'at-top'}`}>{label}</span>
  </button>;
}
