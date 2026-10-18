import { Icon } from './Icon.js';
import type { PlayerSelectionV1 } from '../storage/index.js';
import { OPPONENT_BRANDS, resolveOpponentBrand } from './opponent-brand.js';

export function OpponentLogo({ modelId }: { readonly modelId: string }) {
  const brandId = resolveOpponentBrand(modelId);
  const brand = brandId ? OPPONENT_BRANDS[brandId] : null;
  return <span className="opponent-logo" data-brand={brandId ?? undefined} title={brand?.name ?? 'AI opponent'}>
    {brand ? <img src={brand.logo} alt={`${brand.name} logo`} width={22} height={22} />
      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="AI opponent">
        <path d="M12 3v3M10 3h4M5 11H3v5h2m14-5h2v5h-2" />
        <rect x="5" y="6" width="14" height="14" rx="4" />
        <path d="M9 11v2m6-2v2m-6 3h6" />
      </svg>}
  </span>;
}

export function OpponentBadge({ player, side }: {
  readonly player: PlayerSelectionV1;
  readonly side: 'white' | 'black';
}) {
  if (player.kind === 'model') return <OpponentLogo modelId={player.modelRoutingId} />;
  return <span className={`player-badge ${side === 'white' ? 'light' : 'dark'}-piece`} aria-hidden="true"><Icon name="account" /></span>;
}
