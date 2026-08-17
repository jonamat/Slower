import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { makeWav } from './scripts/wav.mjs';
const TMP = '/tmp/claude-1000/-home-jonathan-projects-transcribe-clone/ea84790d-e2b9-4f84-a068-b221a578d95e/scratchpad/dbg3';
mkdirSync(TMP, { recursive: true });
const URL = 'http://localhost:5199/';
const server = spawn('npx', ['vite', '--port', '5199', '--strictPort'], { cwd: '.', stdio: 'ignore', detached: true });
for (let i = 0; i < 60; i++) { try { await fetch(URL); break; } catch { await new Promise((r) => setTimeout(r, 500)); } }
const wav = `${TMP}/t.wav`;
if (!existsSync(wav)) writeFileSync(wav, makeWav(8));
const b = await chromium.launchPersistentContext(`${TMP}/prof`, { args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'], viewport: { width: 1200, height: 700 } });
const page = await b.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(URL, { waitUntil: 'networkidle' });
await page.setInputFiles('#file', wav);
await page.waitForFunction(() => window.__scribe?.state.ready, null, { timeout: 60000 });

for (const mode of ['both', 'notes']) {
  await page.evaluate(() => {
    window.__scribe.state.pitches.length = 0;
    window.__scribe.addPitch(1.0, 440);
    window.__scribe.addPitch(2.0, 880);
    window.__scribe.setLoopRange(0.5, 3.5);
    window.__scribe.engine.pause();
  });
  await page.selectOption('#playMode', mode);
  await page.evaluate(() => window.__scribe.engine.seek(0.6));
  const s0 = await page.evaluate(() => window.__scribe.state);
  console.log(`\n[${mode}] prima del play: notePos=${s0.notePos.toFixed(3)} pos=${(s0.duration, 0)} fired=${s0.notesFired} mode=${s0.playMode} pitches=${s0.pitches.length}`);
  await page.click('#play');
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(300);
    const s = await page.evaluate(() => ({ ...window.__scribe.state, pos: window.__scribe.engine.position }));
    console.log(`  t=${(i + 1) * 0.3}s pos=${s.pos.toFixed(3)} notePos=${s.notePos.toFixed(3)} fired=${s.notesFired} playing=${s.playing}`);
  }
  await page.evaluate(() => window.__scribe.engine.pause());
}
await b.close();
try { process.kill(-server.pid); } catch {}
