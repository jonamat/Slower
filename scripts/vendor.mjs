/**
 * Copies signalsmith-stretch into public/vendor so the browser loads it byte for
 * byte. It must not go through the bundler: the library builds its own worklet by
 * stringifying its functions, and any identifier renaming breaks that code once it
 * runs inside the AudioWorklet.
 *
 *   node scripts/vendor.mjs
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(ROOT, 'node_modules/signalsmith-stretch');
const to = join(ROOT, 'public/vendor');
mkdirSync(to, { recursive: true });
copyFileSync(join(from, 'SignalsmithStretch.mjs'), join(to, 'SignalsmithStretch.mjs'));
copyFileSync(join(from, 'README.md'), join(to, 'SignalsmithStretch.README.md'));
const version = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')).version;
console.log(`vendored signalsmith-stretch ${version} (MIT) into public/vendor`);
