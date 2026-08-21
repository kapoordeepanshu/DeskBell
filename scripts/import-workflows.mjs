#!/usr/bin/env node
/**
 * Imports workflows/*.json into a running n8n and wires them together.
 *
 * The committed JSON contains placeholders like __DESKBELL_WF_00_CONFIG__ where a
 * sub-workflow id belongs, because those ids do not exist until n8n assigns them
 * on import. This script does a two-pass import: create everything, learn the
 * ids, then patch the references.
 *
 *   N8N_API_KEY=... npm run import
 *
 * Re-running is safe: workflows are matched by name and updated in place, so
 * your credentials and activation state survive.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = join(ROOT, 'workflows');

const API = (process.env.N8N_API_URL || 'http://localhost:5678/api/v1').replace(/\/$/, '');
const KEY = process.env.N8N_API_KEY;

if (!KEY) {
  console.error(`
Missing N8N_API_KEY.

  1. Open n8n  ->  Settings  ->  API  ->  Create an API key
  2. Add it to your .env as N8N_API_KEY=...
  3. Run again:  npm run import

Or import the files by hand: n8n -> Workflows -> Import from File.
If you do that, you must also fix the __DESKBELL_WF_*__ placeholders yourself —
see docs/setup.md.
`.trim());
  process.exit(1);
}

/** Which placeholder maps to which workflow name. */
const PLACEHOLDERS = {
  __DESKBELL_WF_00_CONFIG__: 'deskbell/00 Config',
  __DESKBELL_WF_03_DISPATCHER__: 'deskbell/03 Message Dispatcher',
  __DESKBELL_WF_06_VOICE__: 'deskbell/06 Voice Agent (VAPI)',
  __DESKBELL_WF_08_WAITLIST__: 'deskbell/08 Waitlist Gap-fill',
  __DESKBELL_WF_09_ERRORS__: 'deskbell/09 Error Handler',
};

const PG_CREDENTIAL_NAME = 'deskbell postgres';

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'X-N8N-API-KEY': KEY, 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const detail = body?.message || body?.error || text || res.statusText;
    throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${detail}`);
  }
  return body;
}

/** n8n rejects unknown top-level fields on write, so send only what it accepts. */
const writable = (wf) => ({
  name: wf.name,
  nodes: wf.nodes,
  connections: wf.connections,
  settings: wf.settings || { executionOrder: 'v1' },
});

async function main() {
  console.log(`deskbell -> ${API}\n`);

  let existing;
  try {
    existing = await api('/workflows?limit=250');
  } catch (e) {
    console.error(`Could not reach n8n: ${e.message}\n\nIs it running? Try: docker compose up -d`);
    process.exit(1);
  }

  const byName = new Map((existing.data || []).map((w) => [w.name, w]));
  const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.json')).sort();
  const local = files.map((f) => ({ file: f, wf: JSON.parse(readFileSync(join(WF_DIR, f), 'utf8')) }));

  // ---- pass 1: create or update, learn the real ids
  const idByName = new Map();
  for (const { file, wf } of local) {
    const found = byName.get(wf.name);
    if (found) {
      await api(`/workflows/${found.id}`, { method: 'PUT', body: JSON.stringify(writable(wf)) });
      idByName.set(wf.name, found.id);
      console.log(`  updated  ${file}  (id ${found.id})`);
    } else {
      const created = await api('/workflows', { method: 'POST', body: JSON.stringify(writable(wf)) });
      idByName.set(wf.name, created.id);
      console.log(`  created  ${file}  (id ${created.id})`);
    }
  }

  // ---- find the Postgres credential, if it already exists
  let pgCredentialId = null;
  try {
    const creds = await api('/credentials?limit=250');
    const match = (creds.data || []).find((c) => c.name === PG_CREDENTIAL_NAME);
    if (match) pgCredentialId = match.id;
  } catch {
    // Listing credentials is not available on every n8n version or licence.
  }

  // ---- pass 2: substitute placeholders now that every id is known
  console.log('');
  let patched = 0;
  for (const { file, wf } of local) {
    let json = JSON.stringify(writable(wf));
    let changed = false;

    for (const [placeholder, targetName] of Object.entries(PLACEHOLDERS)) {
      if (!json.includes(placeholder)) continue;
      const id = idByName.get(targetName);
      if (!id) {
        console.warn(`  warn     ${file}: no workflow named "${targetName}" to resolve ${placeholder}`);
        continue;
      }
      json = json.split(placeholder).join(id);
      changed = true;
    }

    if (json.includes('__DESKBELL_PG_CRED__')) {
      if (pgCredentialId) {
        json = json.split('__DESKBELL_PG_CRED__').join(pgCredentialId);
        changed = true;
      }
    }

    if (changed) {
      await api(`/workflows/${idByName.get(wf.name)}`, { method: 'PUT', body: json });
      patched++;
      console.log(`  linked   ${file}`);
    }
  }

  // ---- report
  const configId = idByName.get('deskbell/00 Config');
  console.log(`\n${local.length} workflows imported, ${patched} cross-linked.\n`);

  if (!pgCredentialId) {
    console.log(`Next: create the Postgres credential.

  n8n -> Credentials -> New -> Postgres
    Name:     ${PG_CREDENTIAL_NAME}      <- the name matters
    Host:     postgres        (or localhost if n8n is not in Docker)
    Database: ${process.env.POSTGRES_DB || 'deskbell'}
    User:     ${process.env.POSTGRES_USER || 'deskbell'}
    Password: (your POSTGRES_PASSWORD)

  Then run \`npm run import\` again and it will attach itself to all
  ${local.length} workflows automatically.
`);
  }

  console.log(`Then, in order:

  1. Open "deskbell/00 Config" (id ${configId || '?'}) and edit the INLINE_CONFIG object:
     business name, timezone, currency, avgAppointmentValue, bookingUrl.
  2. Connect the credentials each workflow needs (Twilio / WhatsApp / SMTP / Google).
  3. Point your providers at these webhook URLs:
       inbound replies   ${process.env.DESKBELL_BASE_URL || 'http://localhost:5678'}/webhook/deskbell/inbound
       missed calls      ${process.env.DESKBELL_BASE_URL || 'http://localhost:5678'}/webhook/deskbell/call-status
       VAPI post-call    ${process.env.DESKBELL_BASE_URL || 'http://localhost:5678'}/webhook/deskbell/vapi
       bookings (push)   ${process.env.DESKBELL_BASE_URL || 'http://localhost:5678'}/webhook/deskbell/appointments
  4. Activate the workflows. Start with 09 (errors) and 02 (scheduler).

Workflows are imported INACTIVE on purpose — activating 02 before the config is
right would start texting real customers.`);
}

main().catch((e) => {
  console.error(`\nImport failed: ${e.message}`);
  process.exit(1);
});
