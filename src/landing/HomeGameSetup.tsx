import { lazy, Suspense, useState } from 'react';

const Setup = lazy(async () => {
  const [{ NewGameSetup }, { MatchComposition }] = await Promise.all([
    import('../ui/NewGameSetup'), import('../ui/match-composition'),
  ]);
  function HomeSetup({ onClose, focus }: HomeGameSetupProps) {
    const [composition] = useState(() => new MatchComposition());
    return <NewGameSetup composition={composition} focus={focus} onStarted={() => { onClose(); window.location.assign('/play'); }} />;
  }
  return { default: HomeSetup };
});

interface HomeGameSetupProps { readonly onClose: () => void; readonly focus: 'opponent' | 'time' | 'position' | null }

export function HomeGameSetup({ onClose, focus }: HomeGameSetupProps) {
  return <Suspense fallback={<p role="status">Loading game settings...</p>}><Setup onClose={onClose} focus={focus} /></Suspense>;
}
