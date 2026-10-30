import { useState } from 'react';

/**
 * Copies a shareable value without displaying it. The full value stays on
 * the button (title and data-copy), so tests and hover tooltips can read it.
 */
export function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="button" type="button" title={value} data-copy={value} onClick={() => {
    void navigator.clipboard?.writeText(value).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); },
      () => setCopied(false));
  }}>{copied ? 'Copied' : label}</button>;
}
