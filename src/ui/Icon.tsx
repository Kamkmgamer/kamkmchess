import type { ButtonHTMLAttributes } from 'react';

const paths = {
  close: 'm6 6 12 12M6 18 18 6', back: 'm14 6-6 6 6 6', next: 'm10 6 6 6-6 6',
  first: 'M5 5v14m13-13-6 6 6 6', last: 'M19 5v14M6 6l6 6-6 6',
  settings: 'M4 7h16M4 17h16M9 4v6m6 4v6', flip: 'M4 8h15l-4-4m5 12H5l4 4',
  undo: 'm9 4-5 5 5 5M4 9h9a6 6 0 0 1 0 12', moves: 'M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01',
  board: 'M4 4h16v16H4zM4 12h16M12 4v16', code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',
  archive: 'M4 4h16v5H4zM6 9v11h12V9m-8 4h4', play: 'm8 4 12 8-12 8z', stop: 'M5 5h14v14H5z',
  change: 'M4 7h15l-3-3M20 17H5l3 3', download: 'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',
  account: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2',
  plus: 'M12 4v16M4 12h16', check: 'm5 12 4 4L19 6',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name }: { name: IconName }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
export function IconButton({ icon, label, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return <button type="button" className="button quiet icon-button" aria-label={label} title={label} {...props}><Icon name={icon} /></button>;
}
