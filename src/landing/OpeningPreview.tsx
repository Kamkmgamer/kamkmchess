import { useEffect, useRef, useState } from 'react';
import { Chess, DEFAULT_POSITION } from 'chess.js';
import { Button } from '../components/quartz/ui/button';
import { Icon, Pause, Play, Renew, Settings } from '../components/quartz/icon';
import { OPPONENT_BRANDS } from '../ui/opponent-brand';
import { ChessBoard } from './ChessBoard';
import type { PreviewSetup } from './game-setup';
import { demoFrame, playDemoLoop } from './demo-game';

type PreviewProps = { setup: PreviewSetup; onOptions: () => void };

export function OpeningPreview(props: PreviewProps) {
  const startingFen = props.setup.start.kind === 'custom' ? props.setup.start.position.fen : DEFAULT_POSITION;
  return <AutomaticGame key={startingFen} {...props} startingFen={startingFen} />;
}

function AutomaticGame({ setup, onOptions, startingFen }: PreviewProps & { startingFen: string }) {
  const game = useRef(new Chess(startingFen));
  const [frame, setFrame] = useState(() => demoFrame(new Chess(startingFen)));
  const [playing, setPlaying] = useState(true);
  const [restart, setRestart] = useState(0);
  const [loading, setLoading] = useState(!frame.result);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!playing) return;
    const controller = new AbortController();
    void playDemoLoop(game.current, startingFen, controller.signal,
      next => { if (!controller.signal.aborted) setFrame(next); },
      () => { if (!controller.signal.aborted) setLoading(false); },
    ).catch(reason => {
      if (!controller.signal.aborted) {
        setLoading(false);
        setError(reason instanceof Error ? reason.message : 'The demo could not start. Retry the game.');
      }
    });
    return () => controller.abort();
  }, [playing, restart, startingFen]);

  function restartGame() {
    game.current = new Chess(startingFen);
    setFrame(demoFrame(game.current));
    setError(null);
    setLoading(!game.current.isGameOver());
    setPlaying(true);
    setRestart(current => current + 1);
  }

  const bottomColor = setup.humanColor;
  const topColor = bottomColor === 'w' ? 'b' : 'w';
  const sideName = (side: string) => side === 'w' ? 'White' : 'Black';
  const status = frame.result ? 'Game over' : error ? 'Demo unavailable' : !playing ? 'Game paused'
    : loading ? 'Loading Stockfish 19 Lite' : `${sideName(frame.turn)} to move${frame.check ? ' · Check' : ''}`;
  const recentMoves = frame.moves.slice(-6);

  return (
    <section id="opening-preview" className="preview-section" aria-labelledby="preview-heading">
      <div className="page-width">
        <div className="preview-layout" data-ui>
          <div className="opening-player">
            <div className="preview-player-row" data-active={!frame.result && frame.turn === topColor || undefined}>
              <div className="preview-player-identity"><img className="preview-player-logo" src={OPPONENT_BRANDS.stockfish.logo} alt="Stockfish logo" width="24" height="24" /><span>Stockfish 19</span></div>
              <span className="preview-player-side"><span className="player-piece" data-side={topColor} aria-hidden="true" />{sideName(topColor)}</span>
            </div>
            <ChessBoard board={frame.board} orientation={bottomColor} lastMove={frame.move} label={`Demo game after ${frame.moves.length} moves`} />
            <div className="preview-player-row" data-active={!frame.result && frame.turn === bottomColor || undefined}>
              <div className="preview-player-identity"><img className="preview-player-logo" data-brand="chatgpt" src={OPPONENT_BRANDS.chatgpt.logo} alt="ChatGPT logo" width="24" height="24" /><span>GPT-6.9-Astra</span></div>
              <span className="preview-player-side"><span className="player-piece" data-side={bottomColor} aria-hidden="true" />{sideName(bottomColor)}</span>
            </div>
          </div>
          <div className="opening-guide">
            <div className="preview-copy">
              <h2 id="preview-heading">Watch the<br />game unfold.</h2>
              <p>Stockfish 19 vs GPT-6.9-Astra.</p>
              <div className="preview-configuration">
                <Button variant="secondary" size="lg" onClick={onOptions}><Icon icon={Settings} size={20} />Board options</Button>
                <span>Autoplay · 0.25 sec / move</span>
              </div>
            </div>
            <div className="opening-annotation" aria-live={frame.result || error || !playing ? 'polite' : 'off'} aria-atomic="true">
              <h3>{status}</h3>
              <p>{frame.result ?? error ?? (frame.move ? `${sideName(frame.move.color)} plays ${frame.move.san}.` : 'The game starts automatically. White moves first.')}</p>
            </div>
            <ol className="opening-moves" aria-label="Recent game moves">
              {recentMoves.map((move, index) => (
                <li key={frame.moves.length - recentMoves.length + index} data-current={index === recentMoves.length - 1 || undefined}>
                  <span className="visually-hidden">{move.before.split(' ')[5]}. {sideName(move.color)}: </span>{move.san}
                </li>
              ))}
            </ol>
            <div className="opening-controls">
              <span className="move-count">{frame.moves.length} moves played</span>
              <div className="move-buttons">
                <Button variant="ghost" size="icon-lg" aria-label="Restart game" onClick={restartGame}><Icon icon={Renew} /></Button>
                {error ? <Button size="lg" onClick={restartGame}>Retry game <Icon icon={Renew} /></Button>
                  : <Button size="lg" disabled={!!frame.result && frame.moves.length === 0} onClick={() => setPlaying(current => !current)}>
                    {playing ? 'Pause game' : 'Resume game'} <Icon icon={playing ? Pause : Play} />
                  </Button>}
              </div>
            </div>
            <p className="preview-disclosure">Demo game. Stockfish 19 Lite generates moves for both sides.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
