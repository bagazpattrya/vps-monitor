'use strict';
// Tiny MCP server (stdio, no dependencies) used as Claude's --permission-prompt-tool.
// Tool "approve": Claude calls it before running a tool that is not pre-allowed; we forward the request to the
// monitor, which shows it to the user and answers allow/deny. Tool "tinker": runs Laravel tinker through the
// monitor after the user approves the exact code.
const http = require('http');

const URL_ = process.env.VPSMON_APPROVAL_URL || '';
const TOKEN = process.env.VPSMON_APPROVAL_TOKEN || '';

const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');

function post(route, payload, fallback) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(URL_); } catch { return resolve(fallback('Approval service is not configured')); }
    const body = JSON.stringify({ token: TOKEN, ...payload });
    const req = http.request({ hostname: u.hostname, port: u.port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(fallback('Bad answer from approval service')); } });
    });
    req.on('error', () => resolve(fallback('Approval service unreachable')));
    req.end(body);
  });
}

const ask = (args) => post('/approve', { tool_name: args.tool_name, input: args.input }, (message) => ({ behavior: 'deny', message }));
const tinker = (args) => post('/tinker', { project: args.project, code: args.code }, (output) => ({ ok: false, output }));

const TOOLS = [
  { name: 'approve', description: 'Ask the user to approve a tool call', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } },
  { name: 'tinker', description: 'Run PHP in a Laravel project with "php artisan tinker". The user must approve the exact code first. Pass the project folder name (for example "kane-hr") and complete PHP statements that print what you need with echo, print_r or dump. Use fully qualified class names and no "use" statements. Prefer read-only queries.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, code: { type: 'string' } }, required: ['project', 'code'] } },
];

function handle(msg) {
  if (msg.method === 'initialize') {
    return send({ id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'vpsmon', version: '1.0.0' } } });
  }
  if (msg.method === 'tools/list') return send({ id: msg.id, result: { tools: TOOLS } });
  if (msg.method === 'tools/call') {
    const p = msg.params || {};
    if (p.name === 'tinker') {
      return tinker(p.arguments || {}).then((r) => send({ id: msg.id, result: { content: [{ type: 'text', text: String(r.output) }], isError: !r.ok } }));
    }
    return ask(p.arguments || {}).then((d) => send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(d) }] } }));
  }
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
}

let buf = '';
process.stdin.setEncoding('utf8').on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
