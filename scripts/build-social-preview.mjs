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
import { existsSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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

/**
 * Read width/height straight out of the PNG IHDR — the same 8 bytes GitHub's
 * uploader validates. Trusting the --window-size flag is not the same as
 * checking what actually landed on disk.
 */
function pngSize(file) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(24);
  readSync(fd, buf, 0, 24, 0);
  closeSync(fd);
  if (buf.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') {
    throw new Error(`${file} is not a PNG`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const { width, height } = pngSize(OUT);
const kb = Math.round(statSync(OUT).size / 1024);
console.log(`  assets/social-preview.png  (${width}x${height}, ${kb} KB)`);

// GitHub rejects anything under 640x320 or over 1 MB. Fail here rather than
// letting someone discover it in the upload dialog.
const problems = [];
if (width < 640 || height < 320) problems.push(`too small: ${width}x${height}, GitHub needs at least 640x320`);
if (width !== 1280 || height !== 640) problems.push(`not the recommended 1280x640 (got ${width}x${height})`);
if (kb > 1024) problems.push(`too large: ${kb} KB, GitHub caps social previews at 1 MB`);
if (problems.length) {
  for (const p of problems) console.error(`  FAIL  ${p}`);
  process.exit(1);
}

// A thumbnail proof at the size this card is actually seen. Social previews are
// almost never viewed at 1280px — they unfurl at roughly a third of that in
// Slack, X and LinkedIn. Anything illegible here is illegible in the wild.
if (process.argv.includes('--thumb')) {
  const THUMB = join(ROOT, 'assets', 'social-preview.thumb.png');
  execFileSync(browser, [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=0.32',
    '--window-size=410,205',
    `--screenshot=${THUMB}`,
    pathToFileURL(HTML).href,
  ], { stdio: 'inherit' });
  console.log('  assets/social-preview.thumb.png  (410x205 legibility proof)');
}

console.log(
  '\nGitHub has no API for social previews — upload it by hand:\n' +
  '  repo -> Settings -> Social preview -> Upload an image',
);
