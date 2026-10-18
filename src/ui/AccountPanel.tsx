import { useEffect, useState } from 'react';
import type { AccountSession } from '../accounts';
import { importGuestGames, previewGuestImport } from '../accounts';
import type { GuestImportPort, GuestImportPreview } from '../accounts';

export interface AccountPanelProps {
  readonly session: AccountSession;
  readonly guestImport?: GuestImportPort;
  readonly onIdentityChanged?: () => void;
}

/** Optional account controls. The parent decides where to mount this panel. */
export function AccountPanel({ session, guestImport, onIdentityChanged }: AccountPanelProps) {
  const [identity, setIdentity] = useState(session.identity);
  const [preview, setPreview] = useState<GuestImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => session.subscribe((nextIdentity) => {
    setIdentity((current) => {
      if (current?.accountId !== nextIdentity?.accountId) {
        setPreview(null);
        setSelected(new Set());
        setMessage('');
      }
      return nextIdentity;
    });
  }), [session]);

  async function beginImport() {
    if (!guestImport || !identity) return;
    setBusy(true); setMessage('');
    try {
      const result = await previewGuestImport(guestImport, identity.accountId);
      if (session.identity?.accountId !== result.accountId) throw new Error('The signed-in account changed. Review the import again.');
      setPreview(result);
      setSelected(new Set(result.games.map((game) => game.gameId)));
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function confirmImport() {
    if (!guestImport || !preview) return;
    if (session.identity?.accountId !== preview.accountId) {
      setPreview(null); setSelected(new Set()); setMessage('The signed-in account changed. Review guest games again.');
      return;
    }
    setBusy(true);
    try {
      await importGuestGames(guestImport, preview, [...selected], () => session.identity?.accountId === preview.accountId);
      if (session.identity?.accountId !== preview.accountId) throw new Error('The signed-in account changed during import. No more guest games will be copied.');
      setPreview(null); setMessage('Selected guest games were copied into this account. Guest copies remain on this device.');
      onIdentityChanged?.();
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function signIn() {
    setBusy(true); setMessage('');
    try { await session.signInWithGoogle(); }
    catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true); setMessage('');
    try { await session.signOut(); setPreview(null); setSelected(new Set()); onIdentityChanged?.(); }
    catch (error) { setMessage(session.client?.user ? `Sign-out needs attention. Private games are hidden. Try signing out again: ${errorMessage(error)}` : `You are signed out, but local credential cleanup reported an error: ${errorMessage(error)}`); }
    finally { setBusy(false); }
  }

  return <section aria-labelledby="account-panel-title" className="account-panel">
    <h2 id="account-panel-title">Optional account</h2>
    {!session.enabled && <p>Accounts are not configured. Guest play and local saves are available.</p>}
    {session.enabled && !identity && <>
      <p>Sign in with Google through Clerk to sync private account games. Your guest games stay separate until you choose to import them.</p>
      {session.client?.user && <button type="button" onClick={() => void signOut()} disabled={busy}>Retry sign out</button>}
      <button type="button" onClick={() => void signIn()} disabled={busy}>Continue with Google</button>
    </>}
    {identity && <>
      <p>Signed in. Account games are private to this identity. Guest games and AI credentials stay on this device unless you explicitly import games.</p>
      <div className="account-panel-actions">
        {guestImport && <button type="button" onClick={() => void beginImport()} disabled={busy}>Review guest games</button>}
        <button type="button" onClick={() => void signOut()} disabled={busy}>Sign out</button>
      </div>
    </>}
    {preview && <div aria-labelledby="guest-import-title" className="guest-import-preview">
      <h3 id="guest-import-title">Import guest games</h3>
      <p>{preview.warning}</p>
      {preview.games.length === 0 ? <p>No guest games are available to import.</p> : <fieldset disabled={busy}>
        <legend>Select games to copy into this account</legend>
        {preview.games.map((game) => <label key={game.gameId}>
          <input type="checkbox" checked={selected.has(game.gameId)} onChange={(event) => {
            setSelected((current) => {
              const next = new Set(current);
              if (event.target.checked) next.add(game.gameId);
              else next.delete(game.gameId);
              return next;
            });
          }} />
          <span>{game.gameId} · {game.result}{game.hasDiscardedLines ? ' · includes undone lines' : ''}{game.practice ? ' · practice' : ''}{game.unsynced ? ' · unsynced' : ''}</span>
        </label>)}
      </fieldset>}
      <div className="account-panel-actions">
        <button type="button" onClick={() => void confirmImport()} disabled={busy || selected.size === 0}>Import selected games</button>
        <button type="button" onClick={() => setPreview(null)} disabled={busy}>Cancel</button>
      </div>
    </div>}
    {message && <p role="status" aria-live="polite">{message}</p>}
  </section>;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Please try again.'; }
