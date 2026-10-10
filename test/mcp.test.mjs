// Protocol-level tests for the stdio MCP server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gitRepo, isolatedEnv, SCRIPTS } from './helpers.mjs';

let child;
let buffer = '';
const pending = new Map();
const unsolicited = [];

function send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); }
function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

before(() => {
  const repo = gitRepo({
    'src/db.js': 'export class Database {\n  query(sql) { return sql; }\n}\nexport function connect() { return new Database(); }\n',
    'src/users.js': "import { connect } from './db.js';\nexport function findUser(id) { return connect().query(id); }\n",
    'src/users.test.js': "import { findUser } from './users.js';\ntest('x', () => findUser(1));\n",
    'package.json': '{"scripts":{"test":"node --test"}}',
  });
  const { env } = isolatedEnv({ VERIDONE_PROJECT_DIR: repo });
  child = spawn(process.execPath, [path.join(SCRIPTS, 'mcp-server.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else unsolicited.push(msg);
    }
  });
});

after(() => { child?.stdin.end(); child?.kill(); });

test('initialize negotiates the protocol and advertises tools', async () => {
  const r = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.result.serverInfo.name, 'veridone-intel');
  assert.match(r.result.instructions, /repo_map/);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const old = await request(2, 'initialize', { protocolVersion: '1999-01-01' });
  assert.ok(old.result.protocolVersion.startsWith('20'), 'falls back to a supported version');
});

test('tools/list describes read-only tools with schemas', async () => {
  const r = await request(3, 'tools/list', {});
  const names = r.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['repo_map', 'outline', 'find_symbol', 'impact', 'verification_status']);
  for (const t of r.result.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.annotations.readOnlyHint, true);
    assert.ok(t.description.length > 40);
  }
});

test('tools/call returns useful text', async () => {
  const map = await request(4, 'tools/call', { name: 'repo_map', arguments: { max_tokens: 1000 } });
  assert.equal(map.result.isError, false);
  assert.match(map.result.content[0].text, /src\/db\.js/);
  const sym = await request(5, 'tools/call', { name: 'find_symbol', arguments: { query: 'Database' } });
  assert.match(sym.result.content[0].text, /^src\/db\.js:1 {2}class Database/);
  const out = await request(6, 'tools/call', { name: 'outline', arguments: { files: ['src/db.js'] } });
  assert.match(out.result.content[0].text, /method Database\.query/);
  const imp = await request(7, 'tools/call', { name: 'impact', arguments: { files: ['src/db.js'] } });
  assert.match(imp.result.content[0].text, /Direct dependents \(1\): src\/users\.js/);
  assert.match(imp.result.content[0].text, /Related tests \(1\): src\/users\.test\.js/);
  const vs = await request(8, 'tools/call', { name: 'verification_status', arguments: {} });
  assert.match(vs.result.content[0].text, /No Veridone session ledger found/);
});

test('bad requests produce errors, not crashes', async () => {
  const unknownTool = await request(9, 'tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknownTool.result.isError, true);
  const missingArg = await request(10, 'tools/call', { name: 'outline', arguments: {} });
  assert.equal(missingArg.result.isError, true);
  const unknownMethod = await request(11, 'no/such/method', {});
  assert.equal(unknownMethod.error.code, -32601);
  child.stdin.write('{this is not json}\n');
  const ping = await request(12, 'ping', {});
  assert.deepEqual(ping.result, {});
  assert.ok(unsolicited.some((m) => m.error?.code === -32700), 'parse error reported');
});
