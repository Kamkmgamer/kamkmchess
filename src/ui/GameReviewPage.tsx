import { useEffect, useMemo, useRef, useState } from 'react';
import { applyCoordinateMove, legalMoves, parsePosition } from '../rules/index.js';
import type { CoordinateMove } from '../rules/index.js';
import { coordinateText } from '../review/replay.js';
import { formatEvaluation } from '../engines/uci-score.js';
import { GRADE_LABELS } from '../review/grades.js';
import type { MoveGrade } from '../review/grades.js';
import { reviewGame } from '../review/review.js';
import type { GameReview, ReviewedMove, ReviewProgress } from '../review/review.js';
import { ChessBoard } from './ChessBoard.js';
import { IconButton } from './Icon.js';
import type { RecapInput } from './RecapPage.js';
import './game-review.css';

const ISSUES: readonly MoveGrade[] = ['blunder', 'mistake', 'inaccuracy', 'slight-inaccuracy'];

/** Translate the engine's legal coordinate line into readable chess notation. */
function continuation(move: ReviewedMove, line: readonly string[]): string {
  let position = parsePosition(move.fenBefore);
  const notation: string[] = [];
  for (const uci of line.slice(0, 6)) {
    const candidate = legalMoves(position).find(item => coordinateText(item) === uci);
    if (!candidate) break;
    const next = applyCoordinateMove(position, candidate);
    notation.push(`${position.fullmoveNumber}${position.sideToMove === 'w' ? '.' : '...'}${next.san}`);
    position = next.position;
  }
  return notation.join(' ');
}

export default function GameReviewPage({ input, onClose }: { readonly input: RecapInput; readonly onClose: () => void }) {
  const [review, setReview] = useState<GameReview | null>(null);
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [status, setStatus] = useState<'reviewing' | 'ready' | 'stopped' | 'error'>('reviewing');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [ply, setPly] = useState(0);
  const [orientation, setOrientation] = useState(input.orientation);
  const [practice, setPractice] = useState(false);
  const [practiceMessage, setPracticeMessage] = useState('');
  const [showLine, setShowLine] = useState(false);
  const job = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController(); job.current = controller;
    void reviewGame(input.replay, controller.signal, value => { if (!controller.signal.aborted) setProgress(value); })
      .then(result => { if (!controller.signal.aborted) { setReview(result); setStatus('ready'); } })
      .catch(reason => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : 'Review failed. Please retry.'); setStatus('error'); } });
    return () => controller.abort();
  }, [input, attempt]);

  const selected = ply > 0 ? review?.moves[ply - 1] : undefined;
  const counts = useMemo(() => (['white', 'black'] as const).map(side => ({ side,
    issues: review?.moves.filter(move => move.side === side && ISSUES.includes(move.grade)).length ?? 0,
    strong: review?.moves.filter(move => move.side === side && (move.grade === 'best' || move.grade === 'great')).length ?? 0,
  })), [review]);
  function select(next: number): void {
    setPly(Math.max(0, Math.min(input.replay.moves.length, next)));
    setPractice(false); setPracticeMessage(''); setShowLine(false);
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); select(ply + (event.key === 'ArrowLeft' ? -1 : 1));
      }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  const displayedMove = ply > 0 ? input.replay.moves[ply - 1] : undefined;
  const answer = useMemo(() => {
    if (!selected || !showLine || practice) return null;
    const before = parsePosition(selected.fenBefore);
    const best = legalMoves(before).find(move => coordinateText(move) === selected.bestMove);
    return best ? { position: applyCoordinateMove(before, best).position, move: best } : null;
  }, [selected, showLine, practice]);
  const fen = displayedMove ? (practice ? displayedMove.fenBefore : displayedMove.fenAfter) : input.replay.startingFen;
  const position = useMemo(() => answer?.position ?? parsePosition(fen), [answer, fen]);
  const last = answer ? { from: answer.move.from, to: answer.move.to } : displayedMove && !practice ? { from: displayedMove.uci.slice(0, 2), to: displayedMove.uci.slice(2, 4) } : null;
  const evaluation = selected ? selected.playedScore.kind === 'cp'
    ? formatEvaluation({ kind: 'cp', value: selected.playedScore.value * (selected.side === 'white' ? 1 : -1) })
    : `Mate for ${(selected.playedScore.value > 0) === (selected.side === 'white') ? 'White' : 'Black'}` : null;
  const issueMoves = review?.moves.filter(move => ISSUES.includes(move.grade)) ?? [];
  const nextIssue = issueMoves.find(move => move.ply > ply) ?? issueMoves[0];
  async function tryMove(move: CoordinateMove): Promise<boolean> {
    if (!selected || !practice) return false;
    if (coordinateText(move) === selected.bestMove) {
      setPractice(false); setShowLine(true); setPracticeMessage(`That's Stockfish's first choice: ${selected.bestSan}.`);
    } else setPracticeMessage('That is not Stockfish’s first choice. Try another move or show the answer.');
    return false;
  }
  const percentage = progress?.download ?? (progress ? progress.completed / Math.max(1, progress.total) : 0);
  return <section className="focus-page game-review" aria-label="Game review">
    <div className="panel-heading review-heading"><div><h2 ref={heading} tabIndex={-1}>Game review</h2><p>{input.replay.players.white} vs {input.replay.players.black}</p></div><IconButton icon="close" label="Close review" onClick={onClose} /></div>
    <div className="review-layout">
      <div className="review-board-column">
        <div className="review-player">{input.replay.players[orientation === 'white' ? 'black' : 'white']}</div>
        <ChessBoard orientation={orientation} model={{ position, identity: `${input.replay.gameId}/${ply}/${practice}` }} disabled={!practice} visible onMove={tryMove} view={{ position, lastMove: last }} premoveColor={null} allowPremove={false} />
        <div className="review-player review-player-bottom"><span>{input.replay.players[orientation]}</span><IconButton icon="flip" label="Flip board" onClick={() => setOrientation(side => side === 'white' ? 'black' : 'white')} /></div>
        {answer && <p className="review-board-caption">Showing the position after {selected?.bestSan}.</p>}
        <div className="review-navigation" aria-label="Move navigation"><IconButton icon="first" label="First position" disabled={ply === 0} onClick={() => select(0)} /><IconButton icon="back" label="Previous move" disabled={ply === 0} onClick={() => select(ply - 1)} /><span>{ply} / {input.replay.moves.length}</span><IconButton icon="next" label="Next move" disabled={ply === input.replay.moves.length} onClick={() => select(ply + 1)} /><IconButton icon="last" label="Last move" disabled={ply === input.replay.moves.length} onClick={() => select(input.replay.moves.length)} /></div>
      </div>
      <div className="review-panel">
        {status === 'reviewing' && <div className="review-state" role="status"><h3>Analyzing the game</h3><p>{progress?.download != null ? 'Downloading Stockfish for this browser.' : 'Stockfish is checking each move. You can leave and continue later.'}</p><progress value={percentage} max={1} aria-label="Review progress" /><p>{progress?.engine ?? 'Stockfish'} · {progress?.completed ?? 0} of {input.replay.moves.length} moves</p><button className="button secondary" type="button" onClick={() => { job.current?.abort(); setStatus('stopped'); }}>Pause review</button></div>}
        {(status === 'stopped' || status === 'error') && <div className="review-state"><h3>{status === 'stopped' ? 'Review paused' : 'Review unavailable'}</h3><p role={status === 'error' ? 'alert' : undefined}>{status === 'error' ? error : 'Your completed analysis is saved on this device.'}</p><button className="button primary" type="button" onClick={() => { setError(''); setStatus('reviewing'); setAttempt(value => value + 1); }}>Continue review</button></div>}
        {review && <>
          <div className="review-summary"><h3>Game summary</h3><p>Reviewed with {progress?.engine ?? 'Stockfish'}. Move grades are estimates based on this search.</p><div className="review-summary-grid">{counts.map(({ side, issues, strong }) => <div key={side}><strong>{input.replay.players[side]}</strong><span>{strong} best or great · {issues} to revisit</span></div>)}</div>
            {nextIssue && <button type="button" className="button primary" onClick={() => select(nextIssue.ply)}> {ply === 0 ? 'Start reviewing' : 'Next move to revisit'} </button>}
            {!nextIssue && <p>No inaccuracies, mistakes, or blunders were found in this search.</p>}
          </div>
          <div className="review-feedback" aria-live="polite">{selected ? <><div className="review-move-title"><h3>{selected.label}</h3><span className="review-grade" data-grade={selected.grade}>{GRADE_LABELS[selected.grade]}</span></div><p>{selected.explanation}</p>
            {ISSUES.includes(selected.grade) && selected.bestSan && <><p className="review-advice">Compare your move with <strong>{selected.bestSan}</strong>, Stockfish's first choice. Show the lines to see how play might continue.</p><div className="review-actions"><button className="button secondary" type="button" onClick={() => { setPractice(true); setShowLine(false); setPracticeMessage('Find the move Stockfish prefers.'); }}>Try again</button><button className="button quiet" type="button" onClick={() => { setPractice(false); setShowLine(value => !value); setPracticeMessage(''); }}>{showLine ? 'Hide line' : 'Show best line'}</button></div></>}
            {practiceMessage && <p className="review-practice-message" role="status">{practiceMessage}</p>}
            {showLine && <p className="review-line"><strong>Possible continuation</strong><br />{continuation(selected, selected.bestLine ?? [selected.bestMove])}</p>}
            {showLine && selected.playedLine && ISSUES.includes(selected.grade) && <p className="review-line"><strong>After the move played</strong><br />{continuation(selected, selected.playedLine)}</p>}
            <p className="review-depth">Evaluation: {evaluation} (White?s perspective) ? Search depth {selected.depth}</p>
          </> : <><h3>Explore the moves</h3><p>Choose a move below or use the arrows to step through the game.</p></>}</div>
          <div className="review-moves"><h3>Moves</h3><div className="review-move-list">{review.moves.map(move => <button key={move.ply} type="button" aria-current={ply === move.ply ? 'step' : undefined} onClick={() => select(move.ply)}><span>{move.label}</span><span className="review-grade" data-grade={move.grade}>{GRADE_LABELS[move.grade]}</span></button>)}</div></div>
        </>}
      </div>
    </div>
  </section>;
}
