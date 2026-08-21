#!/usr/bin/env node
/**
 * Cross-checks the SQL embedded in workflows/*.json against data/schema.sql.
 *
 * A typo'd column name in an n8n Postgres node is invisible until the workflow
 * runs against a real database, which for a reminder scheduler means "the night
 * nobody got reminded". This does a structural check at build time.
 *
 * It is not a SQL parser and does not pretend to be — it verifies table and
 * column *existence* for the statement shapes this project actually uses.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemaSql = readFileSync(join(ROOT, 'data', 'schema.sql'), 'utf8');

/* ---------- parse schema.sql into { table: Set<column> } ---------- */

const tables = new Map();
const views = new Set();

for (const m of schemaSql.matchAll(
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?deskbell\.(\w+)\s*\(([\s\S]*?)\n\);/gi,
)) {
  const [, name, bodyRaw] = m;
  const body = bodyRaw
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join(' ');

  const cols = new Set();
  // Split on top-level commas only, so CHECK (a IN ('x','y')) stays intact.
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { cur && cols.add(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) cols.add(cur.trim());

  const names = new Set();
  for (const def of cols) {
    const first = def.trim().split(/\s+/)[0];
    if (/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)$/i.test(first)) continue;
    names.add(first.toLowerCase());
  }
  tables.set(name.toLowerCase(), names);
}

for (const m of schemaSql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+deskbell\.(\w+)/gi)) {
  views.add(m[1].toLowerCase());
}

/* ---------- collect SQL from the workflows ---------- */

const WF_DIR = join(ROOT, 'workflows');
const statements = [];
for (const file of readdirSync(WF_DIR).filter((f) => f.endsWith('.json'))) {
  const wf = JSON.parse(readFileSync(join(WF_DIR, file), 'utf8'));
  for (const node of wf.nodes) {
    if (node.type !== 'n8n-nodes-base.postgres') continue;
    const q = node.parameters?.query;
    if (q) statements.push({ file, node: node.name, sql: q });
  }
}

/* ---------- checks ---------- */

const errors = [];
const known = (t) => tables.has(t) || views.has(t);

for (const { file, node, sql } of statements) {
  const where = `${file} › ${node}`;
  const stripped = sql.replace(/--.*$/gm, '');

  // Common table expressions define names that are not schema tables.
  const ctes = new Set(
    [...stripped.matchAll(/(?:WITH|,)\s+(\w+)\s+AS\s*\(/gi)].map((m) => m[1].toLowerCase()),
  );

  // 1. Every deskbell.<name> must exist.
  for (const m of stripped.matchAll(/deskbell\.(\w+)/gi)) {
    const t = m[1].toLowerCase();
    if (!known(t) && !ctes.has(t)) errors.push(`${where}: unknown table/view "deskbell.${t}"`);
  }

  // 2. INSERT column lists must exist on the target table.
  for (const m of stripped.matchAll(/INSERT\s+INTO\s+deskbell\.(\w+)\s*\(([^)]*)\)/gi)) {
    const t = m[1].toLowerCase();
    if (!tables.has(t)) continue;
    for (const col of m[2].split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)) {
      if (!tables.get(t).has(col)) errors.push(`${where}: deskbell.${t} has no column "${col}" (INSERT)`);
    }
  }

  // 3. UPDATE ... SET assignments must exist on the target table.
  for (const m of stripped.matchAll(/UPDATE\s+deskbell\.(\w+)(?:\s+(?!SET)(\w+))?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|;|$)/gi)) {
    const t = m[1].toLowerCase();
    if (!tables.get(t)) continue;
    let depth = 0, cur = '';
    const assignments = [];
    for (const ch of m[3]) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { assignments.push(cur); cur = ''; continue; }
      cur += ch;
    }
    assignments.push(cur);
    for (const a of assignments) {
      const col = (a.split('=')[0] || '').trim().toLowerCase();
      if (!col || col.includes(' ')) continue;
      if (!tables.get(t).has(col)) errors.push(`${where}: deskbell.${t} has no column "${col}" (UPDATE SET)`);
    }
  }

  // 4. Parameter placeholders must be contiguous from $1 — a skipped number
  //    means the queryReplacement list is misaligned with the SQL.
  const params = [...stripped.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  if (params.length) {
    const max = Math.max(...params);
    for (let i = 1; i <= max; i++) {
      if (!params.includes(i)) errors.push(`${where}: uses $${max} but never $${i}`);
    }
  }
}

/* ---------- report ---------- */

for (const e of errors) console.error(`  FAIL  ${e}`);
console.log(
  `\n${tables.size} tables, ${views.size} views in schema; ` +
  `${statements.length} SQL nodes checked — ${errors.length} error(s).`,
);
process.exit(errors.length ? 1 : 0);
