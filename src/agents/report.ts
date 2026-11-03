/**
 * Reports one finished browser game to the service's browser board.
 *
 * The report is an explicit user action: nothing leaves the device until the
 * player presses the button on the result card. The service learns only what
 * the payload carries — the public model label, the effort the seat played
 * at, the engine strength it faced, the outcome and the move count. It never
 * learns the connection, the credential or the moves.
 */

export interface AgentGameReport {
  /** The id of the finished game, so a retry cannot double count it. */
  readonly clientGameId: string;
  /** The public label of the model, as the service knows it. */
  readonly model: string;
  /** The effort the model seat played at, when it had one. */
  readonly reasoningEffort?: string;
  /** The browser engine's think time per move. */
  readonly engineThinkMs: number;
  /** The outcome from the model's own perspective. */
  readonly result: 'win' | 'draw' | 'loss';
  readonly moveCount: number;
}

/** Reports one game. Answers false while the service is unconfigured or cannot take the report. */
export async function reportAgentGame(apiOrigin: string | null, report: AgentGameReport, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (apiOrigin === null) return false;
  try {
    const response = await fetcher(`${apiOrigin.replace(/\/+$/, '')}/v1/public/agent-games`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({
        clientGameId: report.clientGameId,
        modelName: report.model,
        reasoningEffort: report.reasoningEffort,
        engineThinkMs: report.engineThinkMs,
        result: report.result,
        moveCount: report.moveCount,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
