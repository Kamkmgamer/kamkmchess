import { useEffect, useState } from 'react';
import type { OnlineSwitchState, OwnerSwitches, OwnerSwitchesAnswer } from '../online/owner-switches.js';

const surfaces: readonly { key: keyof OnlineSwitchState; label: string }[] = [
  { key: 'friends', label: 'Friend play' },
  { key: 'queue', label: 'Public queue' },
];

/** The site owner's online switches; renders nothing for anyone else. */
export function OwnerSwitchesPanel({ switches }: { readonly switches: OwnerSwitches }) {
  const [answer, setAnswer] = useState<OwnerSwitchesAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let live = true;
    switches.read().then(next => { if (live) setAnswer(next); }, () => undefined);
    return () => { live = false; };
  }, [switches]);

  if (!answer) return null;

  async function toggle(key: keyof OnlineSwitchState, on: boolean) {
    if (!answer) return;
    const before = answer;
    // The box flips at once and goes back if the service refuses.
    setAnswer({ ...before, state: { ...before.state, [key]: on } });
    setBusy(true); setNotice('');
    try {
      setAnswer(await switches.write({ ...before.state, [key]: on }));
      setNotice('Saved. Reload the game to see the change.');
    } catch (error) {
      setAnswer(before);
      setNotice(error instanceof Error ? error.message : 'Try again.');
    } finally {
      setBusy(false);
    }
  }

  return <fieldset className="owner-switches" disabled={busy}>
    <legend>Online play (site owner)</legend>
    {surfaces.map(({ key, label }) => <label key={key} className="owner-switch">
      <input type="checkbox" checked={answer.state[key]} onChange={event => void toggle(key, event.target.checked)} />
      <span>{label}</span>
      <small>{answer.state[key] === answer.defaults[key] ? 'as configured' : `configured ${answer.defaults[key] ? 'on' : 'off'}`}</small>
    </label>)}
    {notice && <p role="status">{notice}</p>}
  </fieldset>;
}
