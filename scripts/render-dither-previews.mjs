import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';

// The review calls the exact painter used by Grim's DitherGradient.
// It never quantizes the source image or independently implements the Bayer formula.
const root = new URL('../', import.meta.url);
const output = new URL('docs/design/grim-dither-options/', root);
const entry = new URL('.scratch/grim-dither-review-entry.ts', root);
await mkdir(output, { recursive: true });
await mkdir(new URL('.scratch/', root), { recursive: true });
const server = await createServer({ root: fileURLToPath(root), server: { middlewareMode: true }, appType: 'custom' });

try {
  const { heroDitherPresets } = await server.ssrLoadModule('/src/landing/hero-dither.ts');
  const variants = Object.entries(heroDitherPresets).map(([id, preset]) => ({ id, ...preset }));
  await writeFile(entry, [
    'import { paintGradient } from "../src/components/grim-dither-kit/gradient-paint";',
    'import { heroDitherPresets } from "../src/landing/hero-dither";',
    'const checks = [];',
    'for (const scene of document.querySelectorAll("[data-preset]")) {',
    '  if (!(scene instanceof HTMLElement)) continue;',
    '  const entry = Object.entries(heroDitherPresets).find(([id]) => id === scene.dataset.preset);',
    '  if (!entry) throw new Error("Unknown preview preset.");',
    '  const [, preset] = entry;',
    '  for (const layer of preset.layers) {',
    '    const canvas = document.createElement("canvas");',
    '    canvas.className = "gradient-layer";',
    '    scene.append(canvas);',
    '    paintGradient(canvas, null, 1672, 941, { ...layer, to: "transparent" });',
    '    const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;',
    '    if (!pixels) throw new Error("Missing gradient canvas.");',
    '    let minAlpha = 255, maxAlpha = 0;',
    '    for (let i = 3; i < pixels.length; i += 4) { minAlpha = Math.min(minAlpha, pixels[i]); maxAlpha = Math.max(maxAlpha, pixels[i]); }',
    '    if (maxAlpha === 0 || minAlpha === maxAlpha) throw new Error("Missing transparent dither falloff.");',
    '    checks.push({ preset: entry[0], direction: layer.direction, minAlpha, maxAlpha });',
    '  }',
    '}',
    'document.querySelector("#headlines")?.addEventListener("change", (event) => { if (event.target instanceof HTMLInputElement) document.body.classList.toggle("hide-copy", !event.target.checked); });',
    'document.querySelector("#texture")?.addEventListener("change", (event) => { if (event.target instanceof HTMLInputElement) document.body.classList.toggle("zoom", event.target.checked); });',
    'document.querySelector("#overlay")?.addEventListener("change", (event) => { if (event.target instanceof HTMLInputElement) document.body.classList.toggle("overlay-only", event.target.checked); });',
    'console.log(JSON.stringify({ component: "Grim DitherGradient", variants: 4, layers: checks.length, checks }));',
  ].join('\n'));

  const bundle = await build({
    configFile: false,
    root: fileURLToPath(root),
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { write: false, minify: true, lib: { entry: fileURLToPath(entry), name: 'GrimDitherReview', formats: ['iife'] } },
  });
  const outputs = Array.isArray(bundle) ? bundle : [bundle];
  const chunk = outputs.flatMap((item) => 'output' in item ? item.output : []).find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The component preview bundle is missing.');
  const serif = await readFile(new URL('node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2', root));
  const sans = await readFile(new URL('node_modules/@fontsource-variable/inter-tight/files/inter-tight-latin-wght-normal.woff2', root));
  const style = [
    '@font-face{font-family:Instrument;src:url(data:font/woff2;base64,' + serif.toString('base64') + ') format("woff2");font-weight:400;font-display:swap}',
    '@font-face{font-family:Inter;src:url(data:font/woff2;base64,' + sans.toString('base64') + ') format("woff2");font-weight:100 900;font-display:swap}',
    '*{box-sizing:border-box}body{margin:0;color:var(--foreground,#fff);font-family:Inter,Arial,sans-serif}.controls{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px 20px;margin-bottom:16px;font-size:13px}.controls label{display:flex;gap:7px;align-items:center;cursor:pointer}.gallery{display:grid;gap:22px}figure{margin:0}.scene{position:relative;isolation:isolate;aspect-ratio:1672/941;overflow:hidden;border-radius:12px;background:#000}.scene img{display:block;width:100%;height:100%;object-fit:cover}.wash{position:absolute;inset:0;z-index:1;background:oklch(18.5% .016 262);opacity:.6;pointer-events:none}.gradient-layer{position:absolute;inset:0;z-index:2;display:block;width:100%;height:100%;image-rendering:pixelated;pointer-events:none}.copy{position:absolute;inset:0;z-index:3;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;text-align:center;color:#f0f3f8}.copy h2{font:400 clamp(27px,4.8vw,40px)/1 Instrument,Georgia,serif;letter-spacing:-.025em;margin:0 0 20px}.copy p{font-size:clamp(10px,1.3vw,12px);line-height:1.6;margin:0}.action{margin-top:18px;padding:9px 14px;background:#f0f3f8;color:#11151b;font-size:11px;border-radius:5px}.copy .link{font-size:10px;text-decoration:underline;text-underline-offset:3px;margin-top:15px}figcaption{padding-top:11px}figcaption strong{font-size:15px;font-weight:500}figcaption p{font-size:13px;color:var(--muted-foreground,#aeb4bf);line-height:1.45;margin:4px 0 0}.hide-copy .copy{display:none}.zoom .scene img,.zoom .gradient-layer{transform:scale(3);transform-origin:82% 78%;image-rendering:pixelated}.zoom .copy,.zoom .wash,.overlay-only .copy,.overlay-only .wash{display:none}.overlay-only .scene img{visibility:hidden}.source{margin:18px 0 0;font-size:12px;line-height:1.5;color:var(--muted-foreground,#aaa)}a{color:inherit}@media(max-width:440px){.controls{justify-content:flex-start;gap:10px 16px}.copy h2{font-size:27px;margin-bottom:12px}.copy p{display:none}.action{margin-top:0;font-size:10px;padding:7px 12px}.copy .link{display:none}figcaption p{font-size:12px}}',
  ].join('\n');
  const figures = variants.map((variant, index) => '<figure><div class="scene" data-preset="' + variant.id + '"><img src="../../../public/images/hero-options/01-knight-vs-models.png" alt="Original hero image with Grim’s ' + variant.label + ' gradient"><div class="wash"></div><div class="copy" aria-hidden="true"><h2>Chess against a<br>different mind.</h2><p>Play against AI models that choose their own moves.<br>A familiar game, with a new kind of opponent.</p><span class="action">Set up your game</span><span class="link">Explore the board preview</span></div></div><figcaption><strong>' + (index + 1) + '. ' + variant.label + '</strong><p>' + variant.description + '</p></figcaption></figure>').join('');
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grim Dither Kit hero overlays</title><style>' + style + '</style></head><body><div class="controls"><label><input id="headlines" type="checkbox" checked>Show hero copy</label><label><input id="texture" type="checkbox">Texture close-up</label><label><input id="overlay" type="checkbox">Overlay only</label></div><main class="gallery">' + figures + '</main><p class="source">Rendered with the actual <a href="https://www.tripwire.sh/dither-kit" target="_blank" rel="noreferrer">DitherGradient from Grim’s Dither Kit</a>. The original image stays intact beneath the transparent overlay.</p><script>' + chunk.code.replaceAll('</script', '<\\/script') + '</script></body></html>';
  await writeFile(new URL('index.html', output), html);
  await writeFile(new URL('presets.json', output), JSON.stringify({
    author: 'ripgrim',
    source: 'https://github.com/Boring-Software-Inc/dither-kit',
    revision: '1e7faee9aa252e499651e6736ed65f7a07d9a6bd',
    component: 'DitherGradient',
    method: 'Exact upstream paintGradient over an unchanged original generated hero image.',
    variants,
  }, null, 2) + '\n');
  console.log('Built four previews using the actual Grim DitherGradient painter in ' + fileURLToPath(output));
} finally {
  await server.close();
}
