import { useMemo, useState } from 'react';
import { Chess } from 'chess.js';
import { Button } from '../components/quartz/ui/button';
import { Icon, ChevronLeft, ChevronRight, Renew, Settings } from '../components/quartz/icon';
import { openingFrames, openingMoves } from './opening';
import { ChessBoard } from './ChessBoard';
import { formatSetupClock, type PreviewSetup } from './game-setup';

export function OpeningPreview({ setup, onOptions }: { setup: PreviewSetup; onOptions: () => void }) {
  const [position, setPosition] = useState(0);
  const customGame = useMemo(() => setup.start.kind === 'custom' ? new Chess(setup.start.position.fen) : null, [setup.start]);
  const frame = customGame ? {
    board: customGame.board(), move: null, turn: customGame.turn(),
    note: customGame.isCheckmate() ? 'This position is checkmate. You can keep editing the setup.' : customGame.isStalemate() ? 'This position is stalemate. You can keep editing the setup.' : 'Your custom starting position is shown with your chosen side at the bottom. No clocks have started.',
  } : openingFrames[position] ?? openingFrames[0];

  const lastPosition = openingFrames.length - 1;

  return (
    <section id="opening-preview" className="preview-section" aria-labelledby="preview-heading">
      <div className="page-width">
        <div className="preview-layout" data-ui>
          <div className="opening-player">
            <div className="preview-player-row">
              <div className="preview-player-identity"><span className="player-piece" data-side={setup.humanColor === 'w' ? 'b' : 'w'} aria-hidden="true" /><span title={setup.modelId ?? undefined}>{setup.modelId ?? 'Your AI model'}</span></div>
              <span className="preview-clock">{formatSetupClock(setup.minutes)}</span>
            </div>
            <ChessBoard board={frame.board} orientation={setup.humanColor} lastMove={frame.move} label={customGame ? 'Custom starting position' : `Italian game after ${position} of ${lastPosition} moves`} />
            <div className="preview-player-row">
              <div className="preview-player-identity"><span className="player-piece" data-side={setup.humanColor} aria-hidden="true" /><span>You play {setup.humanColor === 'w' ? 'White' : 'Black'}</span></div>
              <span className="preview-clock">{formatSetupClock(setup.minutes)}</span>
            </div>
          </div>
          <div className="opening-guide">
            <div className="preview-copy">
              <h2 id="preview-heading">{customGame ? <>Explore your<br />own position.</> : <>Explore the<br />Italian opening.</>}</h2>
              <p>{customGame ? 'Load a position, choose your side, and see the board from your perspective.' : 'See how pawns, knights, and bishops build the opening. Advance the board one move at a time.'}</p>
              <div className="preview-configuration">
                <Button variant="secondary" size="lg" onClick={onOptions}><Icon icon={Settings} size={20} />Board options</Button>
                <span>{setup.minutes} min + {setup.incrementSeconds} sec</span>
              </div>
            </div>
            <div className="opening-annotation" role="status" aria-live="polite" aria-atomic="true">
              <h3>{customGame ? `${frame.turn === 'w' ? 'White' : 'Black'} to move` : position === 0 ? 'The starting position' : `${frame.move?.color === 'w' ? 'White' : 'Black'} plays ${frame.move?.san}`}</h3>
              <p>{frame.note}</p>
            </div>
            {!customGame && <>
              <ol className="opening-moves" aria-label="Opening moves">
                {openingMoves.map((san, index) => (
                  <li key={index} data-current={position === index + 1 || undefined} data-played={position > index || undefined} aria-current={position === index + 1 ? 'step' : undefined}>
                    <span className="move-number" aria-hidden="true">{index % 2 === 0 ? `${index / 2 + 1}.` : '…'}</span>
                    <span className="visually-hidden">Move {index + 1}: </span>{san}
                  </li>
                ))}
              </ol>
              <div className="opening-controls">
                <span className="move-count">{position} / {lastPosition} moves</span>
                <div className="move-buttons">
                  <Button variant="ghost" size="icon-lg" aria-label="Restart opening" disabled={position === 0} onClick={() => setPosition(0)}>
                    <Icon icon={Renew} />
                  </Button>
                  <Button variant="ghost" size="icon-lg" aria-label="Previous move" disabled={position === 0} onClick={() => setPosition((current) => Math.max(0, current - 1))}>
                    <Icon icon={ChevronLeft} />
                  </Button>
                  <Button size="lg" disabled={position === lastPosition} onClick={() => setPosition((current) => Math.min(lastPosition, current + 1))}>
                    Next move <Icon icon={ChevronRight} />
                  </Button>
                </div>
              </div>
            </>}
            <p className="preview-disclosure">Opening preview. Choose Play against AI for a full match.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
