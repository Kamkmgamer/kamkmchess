// The five kinds Quartz maps to hue slots, and the two reserved statuses. tokens.css holds the map from
// kind to slot; this file is the type and the order, so components and docs never spell the list again.

export const kinds = ['agent', 'key', 'run', 'deploy', 'model'] as const;
export type Kind = (typeof kinds)[number];

/** Reserved hues. Warm means warn or fail: no kind may take either. */
export const reserved = ['warn', 'fail'] as const;
export type Reserved = (typeof reserved)[number];
