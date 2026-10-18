/* global indexedDB, location, document, Blob, URL, console, btoa, setTimeout */
// Paste this entire file into Chrome's console on the chess app's tab.
// Reads game records only. Does not load the app, resume play, or read credentials.
(async () => {
  const names = (await indexedDB.databases()).map(database => database.name);
  const databaseName = 'kamkmchess-local';
  if (!names.includes(databaseName)) {
    throw new Error(`No saved chess games at ${location.origin}. Run this on the failed game's tab.`);
  }
  const request = operation => new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
  const database = await request(indexedDB.open(databaseName));
  let inventory, games;
  try {
    // One readonly transaction keeps checkpoints and their archive records consistent.
    const transaction = database.transaction(['checkpoints', 'events', 'chunks'], 'readonly');
    const completed = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    const [checkpoints, events, chunks] = await Promise.all(
      ['checkpoints', 'events', 'chunks'].map(store => request(transaction.objectStore(store).getAll())),
    );
    await completed;
    if (!checkpoints.length) throw new Error('This browser address has no saved matches.');
    const players = game => Object.values(game.selections?.players ?? {});
    const sol = game => players(game).some(player => /gpt.*sol/i.test(player.modelRoutingId ?? ''));
    const engine = game => players(game).some(player => /stockfish/i.test(player.modelRoutingId ?? ''));
    const ordered = checkpoints.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const matches = ordered.filter(game => sol(game) && engine(game));
    const candidates = matches.length ? matches : ordered.filter(game => (game.rules?.moves?.length ?? 0) > 0);
    const selected = (candidates.length ? candidates : ordered).slice(0, 3);
    inventory = ordered.map(game => ({
      gameId: game.gameId, moves: game.rules?.moves?.length ?? 0,
      models: players(game).map(player => player.modelRoutingId ?? 'human'),
      updatedAt: new Date(game.updatedAtMs).toISOString(), result: game.result,
    }));
    games = selected.map(checkpoint => ({
      // Do not export records quarantined by the app's credential-echo checks.
      checkpoint: checkpoint.archive?.egressStatus === 'credential-echo-quarantined'
        ? { gameId: checkpoint.gameId, omitted: 'credential-echo-quarantined' } : checkpoint,
      events: events.filter(event => event.gameId === checkpoint.gameId && event.egressStatus !== 'credential-echo-quarantined'),
      chunks: chunks.filter(chunk => chunk.gameId === checkpoint.gameId && chunk.egressStatus !== 'credential-echo-quarantined'),
    }));
  } finally {
    database.close();
  }
  const base64 = bytes => {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    return btoa(binary);
  };
  const data = { format: 'kamkmchess-debug-v1', origin: location.origin, exportedAt: new Date().toISOString(), inventory, games };
  const json = JSON.stringify(data, (_key, value) => value instanceof Uint8Array
    ? { encoding: 'base64', data: base64(value) } : value, 2);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'kamkmchess-debug.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  console.table(inventory);
  console.info(`Downloaded ${link.download}. Exported ${games.length} match(es); no connection store was read.`);
  return { file: link.download, games: games.map(game => game.checkpoint.gameId) };
})()
