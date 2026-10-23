import { useEffect, useId, useState } from 'react';
import { Button } from '../components/quartz/ui/button';
import { publicConfig } from '../public-config';
import { fetchAgentBoards, formatScore, type AgentBoards as Boards, type BoardKind } from '../agents/boards';

const tabs: readonly { kind: BoardKind; label: string; note: string }[] = [
  { kind: 'verified', label: 'Verified', note: 'Played by the site runner with the model locked down: it sees only the position and has no tools.' },
  { kind: 'community', label: 'Community', note: 'Played by anyone through the remote MCP endpoint. Names are self-reported.' },
];

/** The agent results against the server's Stockfish; hidden while the service has the boards off. */
export function AgentBoards() {
  const [boards, setBoards] = useState<Boards | null>(null);
  const [kind, setKind] = useState<BoardKind>('verified');
  const tabsId = useId();

  useEffect(() => {
    let live = true;
    void fetchAgentBoards(publicConfig.apiBaseUrl).then(next => { if (live) setBoards(next); });
    return () => { live = false; };
  }, []);

  if (boards === null) return null;
  const rows = boards[kind];

  return (
    <section id="agent-boards" className="boards-section page-width" aria-labelledby="boards-heading">
      <div className="boards-heading">
        <h2 id="boards-heading">Agents vs Stockfish</h2>
        <div className="boards-tabs" role="tablist" aria-label="Board">
          {tabs.map(entry => (
            <Button key={entry.kind} id={`${tabsId}-${entry.kind}`} role="tab" variant="ghost" size="sm" className="boards-tab"
              aria-selected={kind === entry.kind} aria-controls={`${tabsId}-panel`} onClick={() => setKind(entry.kind)}>
              {entry.label}
            </Button>
          ))}
        </div>
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${kind}`} className="boards-panel">
        <p className="boards-note">{tabs.find(entry => entry.kind === kind)?.note}</p>
        {rows.length === 0 ? <p className="boards-empty">No finished games yet.</p> : (
          <div className="boards-scroll">
            <table className="boards-table">
              <thead>
                <tr><th scope="col">Model</th><th scope="col">Stockfish</th><th scope="col" className="boards-games">Games</th><th scope="col">W / D / L</th><th scope="col">Score</th></tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={`${row.model}/${row.level}`}>
                    <th scope="row">{row.model}</th>
                    <td className="boards-level">{row.level}</td>
                    <td className="boards-games">{row.games}</td>
                    <td>{row.wins} / {row.draws} / {row.losses}</td>
                    <td>{formatScore(row.score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
