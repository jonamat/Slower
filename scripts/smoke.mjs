/**
 * Headless smoke test: loads a synthetic track, checks the spectrogram job,
 * zoom/pan, and that the WSOLA loop actually wraps inside its bounds.
 *
 *   node scripts/smoke.mjs [url]      # starts its own dev server unless a url is given
 *
 * Writes screenshots to scripts/.tmp/.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWav } from './wav.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, '.tmp');
mkdirSync(TMP, { recursive: true });

let server = null;
let URL = process.argv[2];
if (!URL) {
  URL = 'http://localhost:5199/';
  server = spawn('npx', ['vite', '--port', '5199', '--strictPort'], {
    cwd: join(HERE, '..'), stdio: 'ignore', detached: true,
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(URL); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
}
const stopServer = () => { if (server) try { process.kill(-server.pid); } catch { /* gone */ } };

const wav = join(TMP, 'test.wav');
if (!existsSync(wav)) writeFileSync(wav, makeWav(8));

// persistent context: localStorage and IndexedDB must survive the reload,
// but every run starts from a clean profile
const PROFILE = join(TMP, 'profile');
rmSync(PROFILE, { recursive: true, force: true });
const browser = await chromium.launchPersistentContext(PROFILE, {
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio'],
  viewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
page.setDefaultTimeout(60000); // software rendering: screenshots get slow under load
const errors = [];
const watch = (p) => {
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
};
watch(page);

await page.goto(URL, { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  localStorage.clear();
  sessionStorage.clear(); // the live state is per tab
  // start cold: no spectrum or waveform cache
  await new Promise((res) => { const r = indexedDB.deleteDatabase('spectroscribe'); r.onsuccess = r.onerror = res; });
});
await page.reload({ waitUntil: 'networkidle' });

// the welcome card only shows on first run: dismiss it before touching the plot
await page.waitForTimeout(300);
const welcomeShown = await page.evaluate(() => document.getElementById('welcome').open);
await page.click('#welcomeBtn');
await page.waitForTimeout(200);
const welcomeSticks = await page.evaluate(() => localStorage.getItem('slower.welcome.v1') === '1');
console.log(`presentazione: al primo avvio=${welcomeShown} memorizzata=${welcomeSticks}`);

await page.setInputFiles('#file', wav);
const cold = await ready(page);
console.log('a freddo:', describe(cold), `· barra di stato: "${await page.textContent('#stMsg')}"`);

// zoom with the wheel, then drag to pan
await page.mouse.move(700, 500);
await page.mouse.wheel(0, -600);
await page.mouse.down();
await page.mouse.move(560, 470, { steps: 8 });
await page.mouse.up();
await page.screenshot({ path: join(TMP, 'shot-zoom.png') });
console.log('view:', JSON.stringify(await page.evaluate(() => {
  const v = window.__scribe.view;
  return { t0: +v.t0.toFixed(3), tSpan: +v.tSpan.toFixed(3), fMin: Math.round(v.fMin), fMax: Math.round(v.fMax) };
})));

// ctrl+wheel scrolls back and forth in time without changing the zoom
const before = await page.evaluate(() => ({ ...window.__scribe.view }));
await page.keyboard.down('Control');
await page.mouse.wheel(0, 300);
await page.keyboard.up('Control');
const after = await page.evaluate(() => ({ ...window.__scribe.view }));
console.log('ctrl+wheel:', `t0 ${before.t0.toFixed(3)} → ${after.t0.toFixed(3)}`,
  `span invariato=${Math.abs(after.tSpan - before.tSpan) < 1e-6}`);
const scrolled = after.t0 > before.t0 && Math.abs(after.tSpan - before.tSpan) < 1e-6;

// the checks below read exact positions, so they run on the in-house player: the
// WASM one reports its own compensated time and would blur them by a few ms
await page.evaluate(() => {
  document.getElementById('algo').value = 'wsola';
  document.getElementById('algo').dispatchEvent(new Event('change'));
});
await page.waitForTimeout(200);

// loop 1s..3s at 60%: play from a stop jumps to the selection start, then the
// cursor stays inside and wraps. Play icon → pause.
await page.evaluate(() => {
  window.__scribe.setLoopRange(1, 3);
  window.__scribe.engine.seek(6);
});
await page.fill('#rate', '60');
await page.dispatchEvent('#rate', 'input');
const rateShown = await page.textContent('#rateVal');
const iconStopped = await playIcon(page);
await page.click('#play');
await page.waitForTimeout(120);
const iconPlaying = await playIcon(page);
console.log(`velocità slider: ${rateShown} · rate motore ${await page.evaluate(() => window.__scribe.engine.rate)}`);
console.log(`icona: fermo=${iconStopped} in riproduzione=${iconPlaying}`);

// paused inside the selection: play resumes where it stopped
await page.evaluate(() => { window.__scribe.engine.pause(); window.__scribe.engine.seek(2.2); });
await page.click('#play');
await page.waitForTimeout(120);
const resumedAt = await page.evaluate(() => window.__scribe.engine.position);
console.log(`pausa dentro la selezione → riprende da ${resumedAt.toFixed(3)} (atteso ~2.2, non 1.0)`);

// from outside the selection, play jumps to its start
await page.evaluate(() => { window.__scribe.engine.pause(); window.__scribe.engine.seek(6); });
await page.click('#play');
await page.waitForTimeout(120);
const atStart = await page.evaluate(() => window.__scribe.engine.position);
console.log('play con selezione → cursore a', atStart.toFixed(3), '(atteso ~1.0)');
const pos = [];
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(60); // dense enough to catch the cursor near the loop end
  pos.push(await page.evaluate(() => window.__scribe.engine.position));
}
// latency correction must not push the cursor out of the selection, and the
// cursor has to walk the whole region, not stop short of its end
const inside = pos.every((p) => p >= 0.99 && p <= 3.05);
const spansLoop = Math.max(...pos) >= 2.9;
const wrapped = pos.some((p, i) => i > 0 && p < pos[i - 1] - 0.5);
console.log(`loop: ${Math.min(...pos).toFixed(3)} → ${Math.max(...pos).toFixed(3)}`,
  `inside=${inside} spans=${spansLoop} wrapped=${wrapped} advanced=${pos[0] !== pos.at(-1)}`);
await page.evaluate(() => window.__scribe.engine.pause());
await page.screenshot({ path: join(TMP, 'shot-loop.png') });

// the pointer turns into ew-resize over a selection edge
// (paused and fitted: with follow on, the view keeps moving)
await page.click('#zoomAll');
const cursorOn = await (async () => {
  const edgeX = await page.evaluate(() => {
    const v = window.__scribe.view;
    const w = document.getElementById('plot').clientWidth;
    return ((window.__scribe.state.loopA - v.t0) / v.tSpan) * w;
  });
  const b = await page.locator('#ovl').boundingBox();
  await page.mouse.move(b.x + edgeX, b.y + 200);
  const onEdge = await page.evaluate(() => document.getElementById('ovl').style.cursor);
  await page.mouse.move(b.x + edgeX + 60, b.y + 200);
  const offEdge = await page.evaluate(() => document.getElementById('ovl').style.cursor);
  console.log(`puntatore: sul bordo="${onEdge}" fuori="${offEdge}"`);
  return onEdge === 'ew-resize' && offEdge === 'crosshair';
})();

// markers: M key, progressive labels, ctrl+click on a flag deletes
await page.evaluate(() => { window.__scribe.engine.pause(); window.__scribe.engine.seek(1.5); });
await page.keyboard.press('m');
await page.evaluate(() => window.__scribe.engine.seek(2.5));
await page.keyboard.press('m');
let marks = await page.evaluate(() => window.__scribe.state.markers.map((m) => `${m.label}@${m.t.toFixed(2)}`));
console.log('marker creati:', marks.join(' '));
const box = await page.locator('#ovl').boundingBox();
const markX = await page.evaluate(() => {
  const v = window.__scribe.view;
  const w = document.getElementById('plot').clientWidth;
  return ((window.__scribe.state.markers[0].t - v.t0) / v.tSpan) * w;
});
await page.screenshot({ path: join(TMP, 'shot-markers.png') });
// plain click on a flag: moves the cursor, the marker stays
await page.mouse.click(box.x + markX, box.y + 12);
const survived = await page.evaluate(() => window.__scribe.state.markers.length);
// ctrl+click: deletes
await page.keyboard.down('Control');
await page.mouse.click(box.x + markX, box.y + 12);
await page.keyboard.up('Control');
const marksAfter = await page.evaluate(() => window.__scribe.state.markers.map((m) => m.label));
console.log(`click semplice: ${survived} marker restano · dopo ctrl+click: ${marksAfter.join(' ') || '(nessuno)'}`);
// right click away from any marker adds one there; over a marker it removes it
const emptyX = await page.evaluate(() => {
  const v = window.__scribe.view;
  const w = document.getElementById('plot').clientWidth;
  const xs = window.__scribe.state.markers.map((m) => ((m.t - v.t0) / v.tSpan) * w);
  // first point inside the plot and clear of every flag
  for (let x = 40; x < w - 40; x += 10) if (xs.every((mx) => Math.abs(mx - x) > 40)) return x;
  return w / 2;
});
const posBefore = await page.evaluate(() => window.__scribe.engine.position);
await page.mouse.click(box.x + emptyX, box.y + 12, { button: 'right' });
const added = await page.evaluate(() => window.__scribe.state.markers.map((m) => m.label));
await page.mouse.click(box.x + emptyX, box.y + 12, { button: 'right' });
const removed = await page.evaluate(() => window.__scribe.state.markers.map((m) => m.label));
const posAfter = await page.evaluate(() => window.__scribe.engine.position);
console.log(`click destro nel righello: aggiunge → ${added.join(' ')} · di nuovo sopra → ${removed.join(' ')}`,
  `· cursore ${posBefore.toFixed(3)} → ${posAfter.toFixed(3)} (deve restare fermo)`);
const rightClickOk = added.length === 2 && removed.length === 1 && removed[0] === 'B'
  && posAfter === posBefore;

// right click on the spectrum pins a note, not a time marker
const PLOT_Y = 260;
const expectedMidi = await page.evaluate((yy) => {
  const v = window.__scribe.view;
  const h = document.getElementById('plot').clientHeight;
  const frac = (h - yy) / (h - 42); // 42 = righello + corsia
  const f = v.log ? v.fMin * Math.pow(v.fMax / v.fMin, frac) : v.fMin + (v.fMax - v.fMin) * frac;
  return Math.round(69 + 12 * Math.log2(f / 440));
}, PLOT_Y);
const expectedT = await page.evaluate((xx) => {
  const v = window.__scribe.view;
  return v.t0 + (xx / document.getElementById('plot').clientWidth) * v.tSpan;
}, emptyX);
const marksBeforePitch = await page.evaluate(() => window.__scribe.state.markers.length);
await page.mouse.click(box.x + emptyX, box.y + PLOT_Y, { button: 'right' });
const pinned = await page.evaluate(() => window.__scribe.state.pitches.map((p) => `${p.midi}@${p.t.toFixed(3)}`));
const marksAfterPitch = await page.evaluate(() => window.__scribe.state.markers.length);
await page.screenshot({ path: join(TMP, 'shot-pitch.png') });
// a right click at the same pitch but elsewhere in time must not remove that note
await page.mouse.click(box.x + emptyX + 120, box.y + PLOT_Y, { button: 'right' });
const twoPinned = await page.evaluate(() => window.__scribe.state.pitches.length);
await page.mouse.click(box.x + emptyX + 120, box.y + PLOT_Y, { button: 'right' });
await page.mouse.click(box.x + emptyX, box.y + PLOT_Y, { button: 'right' });
const unpinned = await page.evaluate(() => window.__scribe.state.pitches.length);
console.log(`nota fissata: ${pinned.join(' ')} (attesi midi ${expectedMidi} @ ${expectedT.toFixed(3)}s)`,
  `· stessa altezza altrove → ${twoPinned} note · dopo la rimozione → ${unpinned}`,
  `· marker di tempo invariati=${marksBeforePitch === marksAfterPitch}`);
const pitchOk = pinned.length === 1 && pinned[0] === `${expectedMidi}@${expectedT.toFixed(3)}`
  && twoPinned === 2 && unpinned === 0 && marksBeforePitch === marksAfterPitch;
await page.mouse.click(box.x + emptyX, box.y + PLOT_Y, { button: 'right' }); // leave one behind for the memory check

const markersOk = marks.length === 2 && marks[0].startsWith('A@1.5') && marks[1].startsWith('B@2.5')
  && survived === 2 && marksAfter.length === 1 && marksAfter[0] === 'B' && rightClickOk && pitchOk;
await page.evaluate(() => window.__scribe.addMarker(4));

// space: play/pause even with focus on the select, without opening it
await page.evaluate(() => window.__scribe.engine.pause());
await page.focus('#playMode');
const modeBefore = await page.inputValue('#playMode');
await page.keyboard.press(' ');
await page.waitForTimeout(150);
const spacePlays = await page.evaluate(() => window.__scribe.state.playing);
await page.keyboard.press(' ');
await page.waitForTimeout(150);
const spacePauses = !(await page.evaluate(() => window.__scribe.state.playing));
const modeAfter = await page.inputValue('#playMode');
console.log(`spazio con fuoco sulla select: parte=${spacePlays} ferma=${spacePauses} select intatta=${modeBefore === modeAfter}`);
const spaceOk = spacePlays && spacePauses && modeBefore === modeAfter;

// spectrum offset (number field in the side menu)
await page.click('#setBtn');
await page.fill('#specOffset', '30');
await page.dispatchEvent('#specOffset', 'input');
const offset = await page.evaluate(() => window.__scribe.view.offset);
console.log(`scostamento spettro: view.offset=${offset}`);
const offsetOk = Math.abs(offset - 0.03) < 1e-9;
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// the three playback modes: track only, track + notes, notes only
await page.evaluate(() => {
  window.__scribe.setLoopRange(0.5, 3.5);
  window.__scribe.addPitch(1.0, 440);
  window.__scribe.addPitch(2.0, 880);
  window.__scribe.engine.pause();
});
// at full speed the 2.5 s probe clears the notes at 1 s and 2 s with margin
await page.fill('#rate', '100');
await page.dispatchEvent('#rate', 'input');
async function playFor(mode, ms) {
  await page.selectOption('#playMode', mode);
  const from = await page.evaluate(() => window.__scribe.state.notesFired);
  await page.evaluate(() => { window.__scribe.engine.seek(0.6); });
  await page.click('#play');
  await page.waitForTimeout(ms);
  const out = await page.evaluate(() => ({
    fired: window.__scribe.state.notesFired, track: window.__scribe.state.trackVolume,
    pos: window.__scribe.engine.position,
  }));
  await page.evaluate(() => window.__scribe.engine.pause());
  return { fired: out.fired - from, track: out.track };
}
// reference notes must be booked ahead on the audio clock: scheduling them at
// "now" would make them land one device buffer after the audio they mark
await page.evaluate(() => {
  window.__lead = [];
  const ctx = window.__scribe.engine.ctx;
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (t) {
    window.__lead.push(+((t ?? 0) - ctx.currentTime).toFixed(4));
    return start.call(this, t);
  };
});

const onlyTrack = await playFor('track', 2500);
const trackAndNotes = await playFor('both', 2500);
const onlyNotes = await playFor('notes', 2500);
const lead = await page.evaluate(() => window.__lead);
const leadOk = lead.length > 0 && lead.every((v) => v > 0);
console.log(`prenotazione note: anticipo ${lead.join(', ')} s · tutte nel futuro=${leadOk}`);
console.log(`solo traccia: note ${onlyTrack.fired} traccia ${onlyTrack.track}`,
  `· traccia+note: note ${trackAndNotes.fired} traccia ${trackAndNotes.track}`,
  `· solo note: note ${onlyNotes.fired} traccia ${onlyNotes.track}`);
const playModeOk = onlyTrack.fired === 0 && onlyTrack.track === 1
  && trackAndNotes.fired >= 2 && trackAndNotes.track === 1
  && onlyNotes.fired >= 2 && onlyNotes.track === 0;
await page.selectOption('#playMode', 'track');

// every engine must really play at the rate it was asked for, loop after loop:
// a stretcher that spends its time in transient passthrough stops slowing down
await page.evaluate(() => { window.__scribe.engine.pause(); });
await page.fill('#rate', '30');
await page.dispatchEvent('#rate', 'input');
const rates = [];
for (const algo of ['signalsmith', 'wsola', 'pv', 'smear']) {
  await page.evaluate((a) => {
    const s = window.__scribe;
    s.engine.pause();
    document.getElementById('algo').value = a;
    document.getElementById('algo').dispatchEvent(new Event('change'));
    s.setLoopRange(1.0, 1.8);
    s.engine.seek(1.0);
  }, algo);
  await page.click('#play');
  const t0 = Date.now();
  let wraps = 0, prev = 1.0, travelled = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100);
    const p = await page.evaluate(() => window.__scribe.engine.position);
    travelled += p < prev - 0.2 ? (1.8 - prev) + (p - 1.0) : p - prev;
    if (p < prev - 0.2) wraps++;
    prev = p;
  }
  const secs = (Date.now() - t0) / 1000;
  await page.evaluate(() => window.__scribe.engine.pause());
  rates.push({ algo, got: +(travelled / secs).toFixed(2), wraps });
}
console.log('velocità reale al 30%:', rates.map((r) => `${r.algo} x${r.got} (${r.wraps} giri)`).join(' · '));
const ratesOk = rates.every((r) => Math.abs(r.got - 0.3) < 0.08 && r.wraps >= 1);


// restore a plain state for what follows
await page.evaluate(() => {
  const s = window.__scribe;
  s.engine.pause();
  document.getElementById('algo').value = 'signalsmith';
  document.getElementById('algo').dispatchEvent(new Event('change'));
});
await page.fill('#rate', '100');
await page.dispatchEvent('#rate', 'input');

// side menu: FFT size and logarithmic frequency scale
console.log('scala di default:', (await page.evaluate(() => window.__scribe.view.log)) ? 'log' : 'lineare');
await page.click('#setBtn');
await page.waitForTimeout(300);
const menuOpen = await page.evaluate(() => document.getElementById('menu').classList.contains('open'));
await page.selectOption('#fft', '8192');
console.log('cambio FFT:', describe(await ready(page)));
await page.selectOption('#freqScale', 'log');
await page.screenshot({ path: join(TMP, 'shot-menu.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
const menuClosed = !(await page.evaluate(() => document.getElementById('menu').classList.contains('open')));
console.log('menu laterale: apre=%s chiude=%s log=%s', menuOpen, menuClosed,
  await page.evaluate(() => window.__scribe.view.log));
await page.screenshot({ path: join(TMP, 'shot-log8192.png') });

// memory across sessions: stop, save, reopen the page from scratch
await page.click('#play');
await page.evaluate(() => {
  window.__scribe.engine.seek(2.4);
  window.__scribe.persist(true);
});
const saved = await page.evaluate(() => ({
  pos: window.__scribe.engine.position,
  view: { ...window.__scribe.view },
  loop: window.__scribe.state,
  marks: window.__scribe.state.markers.map((m) => `${m.label}@${m.t.toFixed(2)}`),
  pitches: window.__scribe.state.pitches.map((p) => `${p.midi}@${p.t.toFixed(3)}`),
  fft: document.getElementById('fft').value,
  gain: document.getElementById('gain').value,
  specOffset: document.getElementById('specOffset').value,
}));
await page.close();

const page2 = await browser.newPage();
page2.setDefaultTimeout(60000);
watch(page2);
await page2.goto(URL, { waitUntil: 'commit' });
// the restore spinner must show up before the spectrum is ready
let spinnerSeen = false;
try {
  await page2.waitForFunction(
    () => !document.getElementById('loading').classList.contains('hide'),
    null, { timeout: 8000 },
  );
  spinnerSeen = true;
} catch { /* ripristino troppo veloce per vederlo */ }
const warm = await ready(page2);
const spinnerHidden = await page2.evaluate(
  () => document.getElementById('loading').classList.contains('hide'),
);
console.log(`spinner: visibile durante il ripristino=${spinnerSeen} nascosto dopo=${spinnerHidden}`);
const statusBar = await page2.textContent('#stMsg');
console.log('a caldo: ', describe(warm), `· barra di stato: "${statusBar}"`);
const cacheOk = !cold.cached && cold.workers >= 1 && warm.cached && statusBar.trim() === 'test.wav';
const back = await page2.evaluate(() => ({
  pos: window.__scribe.engine.position,
  view: { ...window.__scribe.view },
  loop: window.__scribe.state,
  marks: window.__scribe.state.markers.map((m) => `${m.label}@${m.t.toFixed(2)}`),
  pitches: window.__scribe.state.pitches.map((p) => `${p.midi}@${p.t.toFixed(3)}`),
  fft: document.getElementById('fft').value,
  gain: document.getElementById('gain').value,
  specOffset: document.getElementById('specOffset').value,
  restored: window.__scribe.state.restored,
}));
const near = (a, b, tol = 0.06) => Math.abs(a - b) <= tol;
const checks = {
  restored: back.restored === true,
  traccia: back.loop.trackName === saved.loop.trackName,
  cursore: near(back.pos, saved.pos, 0.12),
  loopA: near(back.loop.loopA, saved.loop.loopA),
  loopB: near(back.loop.loopB, saved.loop.loopB),
  loopOn: back.loop.loopOn === saved.loop.loopOn,
  t0: near(back.view.t0, saved.view.t0),
  tSpan: near(back.view.tSpan, saved.view.tSpan),
  fMin: near(back.view.fMin, saved.view.fMin, 1),
  fMax: near(back.view.fMax, saved.view.fMax, 1),
  log: back.view.log === saved.view.log,
  fft: back.fft === saved.fft,
  gain: back.gain === saved.gain,
  specOffset: back.specOffset === saved.specOffset && back.specOffset === '30',
  markers: back.marks.join(' ') === saved.marks.join(' ') && back.marks.length === 2,
  pitches: back.pitches.join(',') === saved.pitches.join(',') && back.pitches.length > 0,
};
const memoryOk = Object.values(checks).every(Boolean);
if (!memoryOk) {
  console.log('memoria KO:', Object.keys(checks).filter((k) => !checks[k]).join(', '));
  console.log('  salvato: ', JSON.stringify(saved));
  console.log('  ripreso: ', JSON.stringify(back));
}
console.log('memoria: traccia', JSON.stringify(back.loop.trackName),
  `marker [${back.marks.join(' ')}] note [${back.pitches.join(' ')}]`,
  `cursore ${saved.pos.toFixed(2)}→${back.pos.toFixed(2)}`,
  `loop ${back.loop.loopA.toFixed(2)}–${back.loop.loopB.toFixed(2)}`,
  `vista t0=${back.view.t0.toFixed(2)} span=${back.view.tSpan.toFixed(2)} log=${back.view.log}`,
  `fft=${back.fft} gain=${back.gain} · ok=${memoryOk}`);
await page2.screenshot({ path: join(TMP, 'shot-restored.png') });

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
stopServer();
const flags = {
  errors: !errors.length, inside, spansLoop, wrapped, scrolled, memoryOk, markersOk, cacheOk, playModeOk,
  spaceOk, offsetOk, menuOpen, menuClosed, welcomeShown, welcomeSticks, leadOk, ratesOk,
  playFromOutside: Math.abs(atStart - 1) < 0.25,
  iconStopped: iconStopped === 'play', iconPlaying: iconPlaying === 'pausa',
  rate: rateShown === '60%', cursorOn, spinnerSeen, spinnerHidden,
};
const failed = Object.keys(flags).filter((k) => !flags[k]);
if (failed.length) console.log('CONTROLLI FALLITI:', failed.join(', '));
process.exit(failed.length ? 1 : 0);

function describe(r) {
  return `${r.cached ? 'da cache' : `analizzato da ${r.workers} worker`} · ${r.cols} colonne · ${r.ms} ms`;
}

/** Which of the two play-button icons is visible. */
function playIcon(p) {
  return p.evaluate(() => {
    const vis = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none';
    return vis('#play .i-pause') ? 'pausa' : vis('#play .i-play') ? 'play' : 'nessuna';
  });
}

/** Attende lo spettro pronto e restituisce l'esito (cache o analisi, ms, colonne). */
async function ready(p) {
  await p.waitForFunction(() => window.__scribe?.state.ready, null, { timeout: 60000 });
  return p.evaluate(() => window.__scribe.state.ready);
}
