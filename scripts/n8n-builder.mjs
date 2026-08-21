/**
 * Minimal helpers for emitting importable n8n workflow JSON.
 *
 * Node ids are derived deterministically from (workflow, node name) so that
 * rebuilding produces a byte-identical file. Random UUIDs would make every
 * `npm run build` a spurious diff and destroy code review of the workflows.
 */
import { createHash } from 'node:crypto';

/** Deterministic UUID v4-shaped id from a stable seed. */
export function stableId(seed) {
  const h = createHash('sha1').update(seed).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

/** Node type + typeVersion pairs, pinned so imports are reproducible. */
export const T = {
  schedule: ['n8n-nodes-base.scheduleTrigger', 1.2],
  webhook: ['n8n-nodes-base.webhook', 2],
  respond: ['n8n-nodes-base.respondToWebhook', 1.1],
  code: ['n8n-nodes-base.code', 2],
  http: ['n8n-nodes-base.httpRequest', 4.2],
  if: ['n8n-nodes-base.if', 2.2],
  switch: ['n8n-nodes-base.switch', 3.2],
  merge: ['n8n-nodes-base.merge', 3],
  loop: ['n8n-nodes-base.splitInBatches', 3],
  execWorkflow: ['n8n-nodes-base.executeWorkflow', 1.2],
  execTrigger: ['n8n-nodes-base.executeWorkflowTrigger', 1.1],
  errorTrigger: ['n8n-nodes-base.errorTrigger', 1],
  postgres: ['n8n-nodes-base.postgres', 2.5],
  gcal: ['n8n-nodes-base.googleCalendar', 1],
  email: ['n8n-nodes-base.emailSend', 2.1],
  noOp: ['n8n-nodes-base.noOp', 1],
  filter: ['n8n-nodes-base.filter', 2.2],
  sticky: ['n8n-nodes-base.stickyNote', 1],
};

export class Workflow {
  constructor(name, meta = {}) {
    this.name = name;
    this.meta = meta;
    this.nodes = [];
    this.edges = [];
    this._col = 0;
  }

  /** Add a node. `pos` may be [x,y]; otherwise nodes flow left to right. */
  add(kind, name, parameters = {}, opts = {}) {
    const [type, typeVersion] = T[kind];
    const position = opts.pos || [260 + this._col++ * 220, 300];
    const node = {
      parameters,
      id: stableId(`${this.name}::${name}`),
      name,
      type,
      typeVersion,
      position,
    };
    if (opts.credentials) node.credentials = opts.credentials;
    if (opts.continueOnFail) node.onError = 'continueRegularOutput';
    if (opts.alwaysOutputData) node.alwaysOutputData = true;
    if (opts.retryOnFail) { node.retryOnFail = true; node.maxTries = opts.maxTries || 3; node.waitBetweenTries = opts.waitBetweenTries || 2000; }
    if (opts.notes) node.notes = opts.notes;
    if (opts.webhookId) node.webhookId = stableId(`${this.name}::${name}::webhook`);
    this.nodes.push(node);
    return name;
  }

  /** A documentation panel rendered on the canvas. */
  note(content, pos, size = [420, 200]) {
    this.nodes.push({
      parameters: { content, height: size[1], width: size[0], color: 7 },
      id: stableId(`${this.name}::note::${pos.join(',')}`),
      name: `Note ${this.nodes.filter((n) => n.type === T.sticky[0]).length + 1}`,
      type: T.sticky[0],
      typeVersion: T.sticky[1],
      position: pos,
    });
    return this;
  }

  /** Connect `from` output `outputIndex` to `to`. */
  link(from, to, outputIndex = 0) {
    this.edges.push([from, to, outputIndex]);
    return this;
  }

  /** Connect a straight run of nodes. */
  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.link(names[i], names[i + 1]);
    return this;
  }

  toJSON() {
    const connections = {};
    for (const [from, to, out] of this.edges) {
      if (!this.nodes.some((n) => n.name === from)) throw new Error(`${this.name}: edge from unknown node "${from}"`);
      if (!this.nodes.some((n) => n.name === to)) throw new Error(`${this.name}: edge to unknown node "${to}"`);
      connections[from] = connections[from] || { main: [] };
      while (connections[from].main.length <= out) connections[from].main.push([]);
      connections[from].main[out].push({ node: to, type: 'main', index: 0 });
    }
    return {
      name: this.name,
      nodes: this.nodes,
      connections,
      active: false,
      settings: {
        executionOrder: 'v1',
        saveManualExecutions: true,
        saveDataErrorExecution: 'all',
        saveDataSuccessExecution: 'all',
        executionTimeout: 300,
        ...(this.meta.errorWorkflow ? { errorWorkflow: this.meta.errorWorkflow } : {}),
      },
      pinData: {},
      tags: this.meta.tags || [{ name: 'deskbell' }],
      versionId: stableId(`${this.name}::version`),
      meta: { templateCredsSetupCompleted: false },
    };
  }
}

/* ---------- parameter shorthands ---------- */

export const everyMinutes = (n) => ({ rule: { interval: [{ field: 'minutes', minutesInterval: n }] } });
export const everyHour = () => ({ rule: { interval: [{ field: 'hours', hoursInterval: 1 }] } });
export const dailyAt = (hour, minute = 0) => ({ rule: { interval: [{ field: 'days', triggerAtHour: hour, triggerAtMinute: minute }] } });

export const jsCode = (code) => ({ mode: 'runOnceForAllItems', jsCode: code });

export const webhookIn = (path, method = 'POST') => ({
  httpMethod: method,
  path,
  responseMode: 'responseNode',
  options: { rawBody: false },
});

export const sql = (query, replacements) => ({
  operation: 'executeQuery',
  query,
  options: replacements ? { queryReplacement: replacements } : {},
});

export const callWorkflow = (idExpr, mode = 'once') => ({
  workflowId: { __rl: true, value: idExpr, mode: 'id' },
  workflowInputs: { mappingMode: 'defineBelow', value: {} },
  mode: mode === 'each' ? 'each' : 'once',
  options: { waitForSubWorkflow: true },
});

/** IF node with a single boolean expression condition. */
export const ifBool = (expr) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{
      id: stableId(expr),
      leftValue: expr,
      rightValue: '',
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  looseTypeValidation: true,
  options: {},
});

/** Switch node routing on a string expression across named outputs. */
export const switchOn = (expr, values) => ({
  rules: {
    values: values.map((v) => ({
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{
          id: stableId(`${expr}::${v}`),
          leftValue: expr,
          rightValue: v,
          operator: { type: 'string', operation: 'equals' },
        }],
        combinator: 'and',
      },
      renameOutput: true,
      outputKey: v,
    })),
  },
  options: { fallbackOutput: 'extra', renameFallbackOutput: 'other', looseTypeValidation: true },
});
