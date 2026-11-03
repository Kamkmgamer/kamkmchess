import { useState } from 'react';
import type { RefObject } from 'react';
import { toPng } from 'html-to-image';
import { IconButton } from './Icon.js';

// SVG gradients can lose their fragment references inside the SVG foreignObject
// used by html-to-image. Rasterize the board's actual loaded artwork first.
async function rasterizePieces(target: HTMLElement): Promise<() => void> {
  const pieces = Array.from(target.querySelectorAll<HTMLElement>('.board-host piece'));
  const sources = new Map<string, Promise<string>>();
  for (const piece of pieces) {
    const background = getComputedStyle(piece).backgroundImage;
    const source = /^url\(["']?(.*?)["']?\)$/.exec(background)?.[1];
    if (!source || sources.has(source)) continue;
    sources.set(source, new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 256;
        const context = canvas.getContext('2d');
        if (!context) { reject(new Error('Cannot render chess pieces.')); return; }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => reject(new Error('Cannot load chess pieces.'));
      image.src = source;
    }));
  }
  const images = new Map(await Promise.all(Array.from(sources, async ([source, image]) => [source, await image] as const)));
  const previous = pieces.map(piece => ({ piece, value: piece.style.getPropertyValue('background-image'), priority: piece.style.getPropertyPriority('background-image') }));
  for (const { piece } of previous) {
    const source = /^url\(["']?(.*?)["']?\)$/.exec(getComputedStyle(piece).backgroundImage)?.[1];
    const image = source && images.get(source);
    if (image) piece.style.setProperty('background-image', `url("${image}")`);
  }
  return () => { for (const { piece, value, priority } of previous) {
    if (value) piece.style.setProperty('background-image', value, priority);
    else piece.style.removeProperty('background-image');
  } };
}

export function ScreenshotButton({ target }: { readonly target: RefObject<HTMLElement | null> }) {
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const capture = async () => {
    if (!target.current || busy) return;
    setBusy(true);
    setError(false);
    let restorePieces = () => {};
    try {
      restorePieces = await rasterizePieces(target.current);
      const url = await toPng(target.current, {
        pixelRatio: 2,
        backgroundColor: getComputedStyle(target.current).getPropertyValue('--page').trim() || '#ffffff',
        filter: node => !(node instanceof HTMLElement && (
          (node.parentElement === target.current && !node.matches('.player-row, .playing-board')) ||
          node.matches('.board-tools, .promotion-panel, .premove-notice, .premove-plan, .board-inspection, .sr-only') ||
          (node.tagName === 'BUTTON' && !node.classList.contains('evaluation-bar'))
        )),
      });
      const link = document.createElement('a');
      link.download = 'chess-position.png';
      link.href = url;
      link.click();
    } catch {
      setError(true);
    } finally {
      restorePieces();
      setBusy(false);
    }
  };
  return <><IconButton icon="camera" label="Download board screenshot" disabled={busy} onClick={() => void capture()} />
    {error && <span role="alert">Could not create screenshot. Try again.</span>}</>;
}
