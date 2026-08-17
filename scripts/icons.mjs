/**
 * Rasterises public/favicon.svg into the PNG fallbacks, and writes a preview of
 * the icon at the sizes it is actually used at.
 *
 *   node scripts/icons.mjs
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(ROOT, 'public/favicon.svg'), 'utf8');
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 400, height: 240 } });

// preview at the sizes the icon is actually used at
await page.setContent(`<body style="margin:0;background:#20242b;display:flex;align-items:center;gap:26px;padding:24px">
  <div style="width:16px;height:16px">${svg}</div>
  <div style="width:32px;height:32px">${svg}</div>
  <div style="width:64px;height:64px">${svg}</div>
  <div style="width:128px;height:128px">${svg}</div>
</body>`);
await page.screenshot({ path: join(ROOT, 'scripts/.tmp/icon-preview.png') });

// 32 px for older browsers, 180 px for apple-touch
for (const [size, out] of [[32, 'public/favicon.png'], [180, 'public/apple-touch-icon.png']]) {
  const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(`<body style="margin:0"><div style="width:${size}px;height:${size}px">${svg}</div></body>`);
  writeFileSync(join(ROOT, out), await p.screenshot({ omitBackground: false }));
  await p.close();
}
// social card for link previews (og:image)
const card = await b.newPage({ viewport: { width: 1200, height: 630 } });
await card.setContent(`<body style="margin:0;width:1200px;height:630px;background:#080a0f;
    font-family:ui-sans-serif,system-ui,sans-serif;color:#e9eef7;display:flex;flex-direction:column;
    justify-content:center;gap:26px;padding:0 90px;box-sizing:border-box">
  <div style="display:flex;align-items:center;gap:26px">
    <div style="width:104px;height:104px">${svg}</div>
    <div style="font-size:82px;font-weight:800;letter-spacing:-.02em">Slower!</div>
  </div>
  <div style="font-size:36px;line-height:1.35;color:#c8d3e2;max-width:940px">
    Slow music down without changing the pitch, loop the hard bar,
    read the spectrogram.
  </div>
  <div style="display:flex;align-items:center;gap:18px;font-size:26px;color:#9dabbf">
    <span style="color:#4aa3ff">slower.jmat.it</span>
    <span>·</span><span>free &amp; open source</span>
    <span>·</span><span>a Transcribe! alternative</span>
  </div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:12px;background:#4aa3ff"></div>
</body>`);
writeFileSync(join(ROOT, 'public/og.png'), await card.screenshot());
await card.close();

console.log('icons written');
await b.close();
