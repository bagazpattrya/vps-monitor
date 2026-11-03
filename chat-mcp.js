'use strict';
// Tiny MCP server (stdio, no dependencies) used as Claude's --permission-prompt-tool.
// Claude calls the "approve" tool before running a tool that is not pre-allowed; we forward the
// request to the monitor, which shows it to the user and answers allow/deny.
const http = require('http');

const URL_ = process.env.VPSMON_APPROVAL_URL || '';
const TOKEN = process.env.VPSMON_APPROVAL_TOKEN || '';

const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');

function ask(args) {
  return new Promise((resolve) => {
    const deny = (message) => resolve({ behavior: 'deny', message });
    let u;
    try { u = new URL(URL_); } catch { return deny('Approval service is not configured'); }
    const body = JSON.stringify({ token: TOKEN, tool_name: args.tool_name, input: args.input });
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { deny('Bad answer from approval service'); } });
    });
    req.on('error', () => deny('Approval service unreachable'));
    req.end(body);
  });
}

function handle(msg) {
  if (msg.method === 'initialize') {
    return send({ id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'vpsmon', version: '1.0.0' } } });
  }
  if (msg.method === 'tools/list') {
    return send({ id: msg.id, result: { tools: [{ name: 'approve', description: 'Ask the user to approve a tool call', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } }] } });
  }
  if (msg.method === 'tools/call') {
    return ask((msg.params && msg.params.arguments) || {}).then((d) => send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(d) }] } }));
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
