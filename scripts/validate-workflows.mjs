#!/usr/bin/env node
/**
 * Structural validation for workflows/*.json.
 *
 * n8n will happily import a workflow whose Code node has a syntax error and only
 * tell you at 3am when the reminder does not go out. This catches that at build
 * time, in CI, before anyone imports anything.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'workflows');

const TRIGGERS = new Set([
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.manualTrigger',
]);
const STICKY = 'n8n-nodes-base.stickyNote';

const errors = [];
const warnings = [];
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

if (!files.length) errors.push('no workflow files found — run `npm run build` first');

let totalNodes = 0;
let totalCodeNodes = 0;

for (const file of files) {
  const path = join(DIR, file);
  const fail = (msg) => errors.push(`${file}: ${msg}`);
  const warn = (msg) => warnings.push(`${file}: ${msg}`);

  let wf;
  try {
    wf = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`invalid JSON — ${e.message}`);
    continue;
  }

  if (!wf.name) fail('missing workflow name');
  if (!Array.isArray(wf.nodes)) { fail('missing nodes array'); continue; }
  if (typeof wf.connections !== 'object') fail('missing connections object');

  const names = new Set();
  const ids = new Set();

  for (const n of wf.nodes) {
    totalNodes++;
    if (!n.name) { fail('a node has no name'); continue; }
    if (names.has(n.name)) fail(`duplicate node name "${n.name}"`);
    names.add(n.name);

    if (!n.id) fail(`node "${n.name}" has no id`);
    else if (ids.has(n.id)) fail(`duplicate node id on "${n.name}"`);
    else ids.add(n.id);

    if (!n.type) fail(`node "${n.name}" has no type`);
    if (typeof n.typeVersion !== 'number') fail(`node "${n.name}" has no numeric typeVersion`);
    if (!Array.isArray(n.position) || n.position.length !== 2) fail(`node "${n.name}" has a bad position`);

    // Every Code node must actually parse.
    if (n.type === 'n8n-nodes-base.code') {
      totalCodeNodes++;
      const code = n.parameters?.jsCode;
      if (!code) { fail(`Code node "${n.name}" has no jsCode`); continue; }
      try {
        // Wrapped in an async IIFE because node bodies use top-level return.
        new vm.Script(`(async () => {\n${code}\n})`, { filename: `${file}:${n.name}` });
      } catch (e) {
        fail(`Code node "${n.name}" has a syntax error — ${e.message}`);
      }
      if (!/return\s/.test(code)) warn(`Code node "${n.name}" never returns anything`);
    }

    // Unresolved placeholders are expected in the repo, but must be the known set.
    const raw = JSON.stringify(n.parameters || {});
    for (const m of raw.matchAll(/__DESKBELL_[A-Z0-9_]+__/g)) {
      if (!/^__DESKBELL_(WF_\d\d_[A-Z]+|PG_CRED)__$/.test(m[0])) fail(`node "${n.name}" has unknown placeholder ${m[0]}`);
    }
  }

  // Connections must reference real nodes in both directions.
  for (const [from, conn] of Object.entries(wf.connections || {})) {
    if (!names.has(from)) fail(`connection source "${from}" is not a node`);
    for (const [outIdx, targets] of (conn.main || []).entries()) {
      for (const t of targets || []) {
        if (!names.has(t.node)) fail(`"${from}" output ${outIdx} points at missing node "${t.node}"`);
      }
    }
  }

  // Every non-trigger node should be reachable, or it is dead weight on the canvas.
  const reachable = new Set();
  const queue = wf.nodes.filter((n) => TRIGGERS.has(n.type)).map((n) => n.name);
  if (!queue.length) fail('no trigger node');
  queue.forEach((n) => reachable.add(n));
  while (queue.length) {
    const cur = queue.shift();
    for (const targets of wf.connections[cur]?.main || []) {
      for (const t of targets || []) {
        if (!reachable.has(t.node)) { reachable.add(t.node); queue.push(t.node); }
      }
    }
  }
  for (const n of wf.nodes) {
    if (n.type === STICKY || TRIGGERS.has(n.type)) continue;
    if (!reachable.has(n.name)) fail(`node "${n.name}" is unreachable from any trigger`);
  }

  // A workflow that can send must route failures somewhere.
  const sends = wf.nodes.some((n) => n.type === 'n8n-nodes-base.httpRequest' || n.type === 'n8n-nodes-base.emailSend');
  if (sends && !wf.settings?.errorWorkflow && !file.startsWith('09')) {
    warn('sends messages but has no errorWorkflow configured');
  }
}

/* ---------- report ---------- */

for (const w of warnings) console.warn(`  warn  ${w}`);
for (const e of errors) console.error(`  FAIL  ${e}`);

console.log(
  `\n${files.length} workflows, ${totalNodes} nodes, ${totalCodeNodes} Code nodes validated — ` +
  `${errors.length} error(s), ${warnings.length} warning(s).`,
);
process.exit(errors.length ? 1 : 0);
