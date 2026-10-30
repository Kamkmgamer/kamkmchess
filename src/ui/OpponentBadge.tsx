import { Icon } from './Icon.js';
import type { PlayerSelectionV1 } from '../storage/index.js';
import { OPPONENT_BRANDS, resolveOpponentBrand } from './opponent-brand.js';

export function OpponentLogo({ modelId }: { readonly modelId: string }) {
  const brandId = resolveOpponentBrand(modelId);
  const brand = brandId ? OPPONENT_BRANDS[brandId] : null;
  return <span className="opponent-logo" data-brand={brandId ?? undefined} title={brand?.name ?? 'AI opponent'}>
    {brand ? <img src={brand.logo} alt={`${brand.name} logo`} width={22} height={22} />
      : <Icon name="bot" label="AI opponent" />}
  </span>;
}

export function OpponentBadge({ player, side, reportedName }: {
  readonly player: PlayerSelectionV1;
  readonly side: 'white' | 'black';
  /**
   * The name an agent seat reported for itself, when the caller knows one.
   *
   * Agents play under a reserved seat kind, so the routing id alone says
   * nothing; the name the agent reported decides the brand logo.
   */
  readonly reportedName?: string | null;
}) {
  if (player.kind === 'model') return <OpponentLogo modelId={reportedName ?? player.modelRoutingId} />;
  return <span className={`player-badge ${side === 'white' ? 'light' : 'dark'}-piece`} aria-hidden="true"><Icon name="user" /></span>;
}
