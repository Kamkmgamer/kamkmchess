/** Explicit guest transfer flow. Storage-specific enumeration and rebinding stay injected. */
export interface GuestGameSummary {
  readonly gameId: string;
  readonly updatedAtMs: number;
  readonly revision: number;
  readonly result: string;
  readonly hasDiscardedLines: boolean;
  readonly practice: boolean;
  readonly unsynced: boolean;
}

export interface GuestImportPort {
  listGuestGames(): Promise<readonly GuestGameSummary[]>;
  importGuestGame(gameId: string, accountId: string): Promise<void>;
}

export interface GuestImportPreview {
  readonly accountId: string;
  readonly games: readonly GuestGameSummary[];
  readonly warning: string;
}

export async function previewGuestImport(port: GuestImportPort, accountId: string): Promise<GuestImportPreview> {
  if (!accountId.trim()) throw new Error('A signed-in account is required to import guest games.');
  const games = await port.listGuestGames();
  return {
    accountId,
    games: games.map((game) => ({ ...game })),
    warning: 'Import copies the selected complete game records into this account and keeps the original guest records. Rebind AI credentials on this device; credentials are never imported or synced.',
  };
}

export async function importGuestGames(
  port: GuestImportPort,
  preview: GuestImportPreview,
  selectedGameIds: readonly string[],
  isCurrentIdentity: () => boolean = () => true,
): Promise<void> {
  const available = new Set(preview.games.map((game) => game.gameId));
  const selected = [...new Set(selectedGameIds)];
  if (selected.some((id) => !available.has(id))) throw new Error('The guest game list changed. Refresh the preview before importing.');
  for (const gameId of selected) {
    if (!isCurrentIdentity()) throw new Error('The signed-in account changed. Remaining guest games were not copied.');
    await port.importGuestGame(gameId, preview.accountId);
  }
}
