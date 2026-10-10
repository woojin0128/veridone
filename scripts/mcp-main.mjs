// Veridone — MCP server (stdio, newline-delimited JSON-RPC 2.0). Zero dependencies.
// Tools: repo_map, outline, find_symbol, impact, verification_status.

import path from 'node:path';
import { findProjectRoot, loadConfig } from './lib/config.mjs';
import { debugLog, readTextSafe } from './lib/util.mjs';

import { version } from './lib/version.mjs';

const VERSION = version();
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// .mcp.json passes the project directory; plugin MCP servers do not receive it otherwise.
const envDir = [process.env.VERIDONE_PROJECT_DIR, process.env.CLAUDE_PROJECT_DIR].find((v) => v && !v.includes('${'));
const ROOT = findProjectRoot(envDir || process.cwd());

const INSTRUCTIONS = 'Veridone code-intelligence tools. repo_map gives a ranked overview (key files + symbols with line ranges) of an unfamiliar or large repository in ~1.5k tokens — use it before broad exploration. outline lists a file\'s symbols with line ranges so you can read only the part you need. find_symbol locates definitions. impact lists what depends on changed files and which tests to run. verification_status reports which checks actually ran and passed after the latest edits in this session.';

const TOOLS = [
  {
    name: 'repo_map',
    title: 'Repository map',
    description: 'Ranked map of the repository: the most depended-on source files with their key symbols and line ranges, within a token budget. Use it first in an unfamiliar or large codebase instead of listing directories or grepping blindly.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional subdirectory to zoom into, relative to the project root.' },
        focus: { type: 'array', items: { type: 'string' }, description: 'Files you are working on; files related to them rank higher.' },
        max_tokens: { type: 'integer', minimum: 200, maximum: 8000, description: 'Output budget (default 1500).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'outline',
    title: 'File outline',
    description: 'Classes, functions, methods and types of one or more files with line ranges and signatures, so you can Read only the relevant range (offset/limit) instead of whole files.',
    inputSchema: {
      type: 'object',
      properties: { files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 25, description: 'Paths relative to the project root (or absolute).' } },
      required: ['files'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'find_symbol',
    title: 'Find symbol definition',
    description: 'Locate where a class, function, method or type is defined (exact, prefix, substring or camelCase-initials match). Returns file:line with the signature.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name or fragment, e.g. "UserService" or "parseCfg".' },
        kind: { type: 'string', enum: ['class', 'function', 'method', 'type', 'interface', 'enum', 'const', 'module'], description: 'Optional kind filter.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'impact',
    title: 'Change impact',
    description: 'For changed files, list the files that import them (directly and transitively) and the tests most likely to cover them, with a scoped test command. Defaults to the current uncommitted git changes.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Changed files (default: git working-tree changes).' },
        depth: { type: 'integer', minimum: 1, maximum: 4, description: 'Reverse-dependency depth (default 2).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'verification_status',
    title: 'Verification status',
    description: 'What this session changed and which checks (test, typecheck, lint, build) actually ran — and passed or failed — after the latest change, according to Veridone\'s session ledger. Use before claiming the work is done.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function text(t, isError = false) {
  const s = String(t ?? '');
  const capped = s.length > 60000 ? s.slice(0, 60000) + '\n… [truncated]' : s;
  return { content: [{ type: 'text', text: capped }], isError };
}

async function callTool(name, args = {}) {
  const intel = await import('./lib/intel/index.mjs');
  switch (name) {
    case 'repo_map': {
      const maxTokens = Math.min(8000, Math.max(200, Number(args.max_tokens) || 1500));
      const r = intel.repoMap(ROOT, { focus: Array.isArray(args.focus) ? args.focus : [], maxTokens, subdir: args.path || null });
      return text(r.text);
    }
    case 'outline': {
      const files = Array.isArray(args.files) ? args.files : [];
      if (!files.length) return text('Provide at least one file path in "files".', true);
      return text(intel.outline(ROOT, files));
    }
    case 'find_symbol': {
      if (!args.query) return text('Provide "query".', true);
      return text(intel.findSymbol(ROOT, args.query, { kind: args.kind || null, limit: Math.min(100, Number(args.limit) || 20) }));
    }
    case 'impact': {
      let files = Array.isArray(args.files) ? args.files : [];
      if (!files.length) {
        const G = await import('./lib/git.mjs');
        const st = G.status(ROOT, []) || [];
        files = st.filter((e) => e.x !== '!').map((e) => e.path);
        if (!files.length) return text('No changed files found in the git working tree. Pass "files" explicitly.');
      }
      const r = intel.impact(ROOT, files, { depth: Math.min(4, Math.max(1, Number(args.depth) || 2)) });
      const { detectProject } = await import('./lib/project.mjs');
      const { config } = loadConfig({ projectRoot: ROOT });
      const project = detectProject(ROOT, { overrides: config.verify?.commands || {} });
      const cmd = intel.scopedTestCommand(project, r.tests);
      const lines = [];
      lines.push(`Changed: ${r.changed.length} file(s)${r.unknown.length ? ` (not indexed as source: ${r.unknown.slice(0, 5).join(', ')})` : ''}`);
      const direct = r.dependents.filter(([, d]) => d === 1).map(([f]) => f);
      const indirect = r.dependents.filter(([, d]) => d > 1).map(([f]) => f);
      lines.push(`Direct dependents (${direct.length}): ${direct.slice(0, 40).join(', ') || 'none'}${direct.length > 40 ? ', …' : ''}`);
      if (indirect.length) lines.push(`Transitive dependents (${indirect.length}): ${indirect.slice(0, 30).join(', ')}${indirect.length > 30 ? ', …' : ''}`);
      lines.push(`Related tests (${r.tests.length}): ${r.tests.slice(0, 40).join(', ') || 'none found — consider adding tests for this change'}${r.tests.length > 40 ? ', …' : ''}`);
      if (cmd) lines.push(`Scoped test command: ${cmd}`);
      if (project.commands.test) lines.push(`Full suite: ${project.commands.test}`);
      return text(lines.join('\n'));
    }
    case 'verification_status': {
      const { listSessions, Ledger } = await import('./lib/ledger.mjs');
      const { statusReport } = await import('./lib/brief.mjs');
      const { detectProject } = await import('./lib/project.mjs');
      const { config } = loadConfig({ projectRoot: ROOT });
      const project = detectProject(ROOT, { overrides: config.verify?.commands || {} });
      const sessions = listSessions(30);
      for (const s of sessions) {
        const l = new Ledger(s.id);
        const st = l.state();
        if (st.projectRoot && path.resolve(st.projectRoot) === path.resolve(ROOT)) {
          return text(statusReport(st, project, config, { readFile: (p) => readTextSafe(path.resolve(ROOT, p)), sessionId: s.id }));
        }
      }
      return text('No Veridone session ledger found for this project yet.');
    }
    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

let warmed = false;
function warm() {
  if (warmed) return;
  warmed = true;
  setTimeout(async () => {
    try {
      const intel = await import('./lib/intel/index.mjs');
      intel.buildIndex(ROOT);
    } catch (e) { debugLog('mcp warm failed', String(e)); }
  }, 1500).unref();
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED.includes(requested) ? requested : SUPPORTED[1];
        return reply(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'veridone-intel', title: 'Veridone code intelligence', version: VERSION }, instructions: INSTRUCTIONS });
      }
      case 'notifications/initialized':
        warm();
        return undefined;
      case 'ping':
        return isRequest ? reply(id, {}) : undefined;
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call': {
        const t0 = Date.now();
        const result = await callTool(params?.name, params?.arguments || {});
        debugLog('mcp tool', params?.name, `${Date.now() - t0}ms`);
        return reply(id, result);
      }
      case 'resources/list': return reply(id, { resources: [] });
      case 'prompts/list': return reply(id, { prompts: [] });
      default:
        if (method?.startsWith('notifications/')) return undefined;
        if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
        return undefined;
    }
  } catch (e) {
    debugLog('mcp error', method, String(e?.stack || e));
    if (isRequest) {
      if (method === 'tools/call') return reply(id, text(`Veridone tool error: ${e?.message || e}`, true));
      return fail(id, -32603, String(e?.message || e));
    }
    return undefined;
  }
}

let buffer = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) queue = queue.then(() => handle(m));
  }
});
process.stdin.on('end', () => { queue.then(() => process.exit(0)); });
process.on('uncaughtException', (e) => debugLog('mcp uncaught', String(e?.stack || e)));
process.on('unhandledRejection', (e) => debugLog('mcp unhandled', String(e?.stack || e)));
