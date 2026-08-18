/**
 * Measures how long the spectrogram takes to be ready on a long track:
 * the first open (full analysis) against later reopens (IndexedDB cache).
 *
 *   node scripts/bench.mjs [secondi] [url]
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWav } from './wav.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, '.tmp');
const SECONDS = Number(process.argv[2] ?? 240);
mkdirSync(TMP, { recursive: true });

let URL = process.argv[3];
let server = null;
if (!URL) {
  URL = 'http://localhost:5199/';
  server = spawn('npx', ['vite', '--port', '5199', '--strictPort'], {
    cwd: join(HERE, '..'), stdio: 'ignore', detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(URL); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
}

const wav = join(TMP, `bench-${SECONDS}s.wav`);
if (!existsSync(wav)) writeFileSync(wav, makeWav(SECONDS));

const browser = await chromium.launchPersistentContext(join(TMP, 'bench-profile'), {
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio'],
  viewport: { width: 1440, height: 900 },
});

async function ready(p) {
  await p.waitForFunction(() => window.__scribe?.state.ready, null, { timeout: 180000 });
  const r = await p.evaluate(() => window.__scribe.state.ready);
  return `${r.cached ? 'da cache' : `analisi su ${r.workers} worker`} · ${r.cols} colonne · ${r.ms} ms`;
}

// cold run: no cache
let page = await browser.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  localStorage.clear();
  await new Promise((res) => { const r = indexedDB.deleteDatabase('spectroscribe'); r.onsuccess = r.onerror = res; });
});
await page.reload({ waitUntil: 'networkidle' });
let t = Date.now();
await page.setInputFiles('#file', wav);
console.log(`${SECONDS}s · prima apertura: ${Date.now() - t} ms  →  ${await ready(page)}`);
await page.evaluate(() => window.__scribe.persist(true));
await page.waitForTimeout(1500); // let the cache write finish
await page.close();

// later reopens: track and spectrum straight from the archive
for (const run of [1, 2]) {
  page = await browser.newPage();
  t = Date.now();
  await page.goto(URL, { waitUntil: 'networkidle' });
  console.log(`${SECONDS}s · riapertura ${run}: ${Date.now() - t} ms  →  ${await ready(page)}`);
  await page.close();
}

await browser.close();
if (server) try { process.kill(-server.pid); } catch { /* already gone */ }
