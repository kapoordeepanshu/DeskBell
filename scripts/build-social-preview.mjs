#!/usr/bin/env node
/**
 * Renders assets/social-preview.html to assets/social-preview.png (1280x640),
 * the size GitHub wants for a repository social preview card.
 *
 * Uses whichever Chrome or Edge is already installed rather than pulling in
 * Puppeteer — this repo has zero runtime dependencies and it stays that way for
 * a build asset.
 *
 *   npm run social
 *
 * Then: GitHub -> repo Settings -> Social preview -> Upload an image.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = join(ROOT, 'assets', 'social-preview.html');
const OUT = join(ROOT, 'assets', 'social-preview.png');

const CANDIDATES = [
  process.env.CHROME_PATH,
  // Windows
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
].filter(Boolean);

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error(
    'No Chrome or Edge found. Set CHROME_PATH to a Chromium-based browser, ' +
    'or open assets/social-preview.html and screenshot it at 1280x640.',
  );
  process.exit(1);
}

mkdirSync(join(ROOT, 'assets'), { recursive: true });

console.log(`rendering with ${browser}`);
execFileSync(browser, [
  '--headless',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--default-background-color=00000000',
  '--window-size=1280,640',
  `--screenshot=${OUT}`,
  pathToFileURL(HTML).href,
], { stdio: 'inherit' });

if (!existsSync(OUT)) {
  console.error('Render produced no file.');
  process.exit(1);
}
const kb = Math.round(statSync(OUT).size / 1024);
console.log(`  assets/social-preview.png  (${kb} KB, 1280x640)`);
if (kb > 1024) console.warn('  warn: GitHub caps social previews at 1 MB.');
