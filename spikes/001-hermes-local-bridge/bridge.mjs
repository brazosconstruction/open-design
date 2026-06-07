#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number.parseInt(process.env.HERMES_BRIDGE_PORT ?? '8787', 10);
const HOST = process.env.HERMES_BRIDGE_HOST ?? '127.0.0.1';
const PROVIDER = process.env.HERMES_BRIDGE_PROVIDER ?? 'openai-codex';
const TOKEN = process.env.HERMES_BRIDGE_TOKEN ?? 'bridge-test-token';
const HERMES_BIN = process.env.HERMES_BRIDGE_HERMES_BIN ?? 'hermes';
const TIMEOUT_MS = Number.parseInt(process.env.HERMES_BRIDGE_TIMEOUT_MS ?? '180000', 10);

function redact(text) {
  return String(text)
    .replace(/Bearer\s+[A-Za-z0-9_.\-+/=]+/g, 'Bearer [REDACTED]')
    .replace(/(access_token|refresh_token|api_key|token)\s*[:=]\s*[^\s,}]+/gi, '$1=[REDACTED]');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendOpenAiStreamChunk(res, text) {
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
}

function sendOpenAiStreamError(res, message) {
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `\n[bridge error] ${message}` } }] })}\n\n`);
}

function sendOpenAiStreamDone(res) {
  res.write('data: [DONE]\n\n');
}

function sendOpenAiModels(res) {
  const created = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: 'list',
    data: [
      { id: 'gpt-5.5', object: 'model', created, owned_by: 'hermes-openai-codex' },
      { id: 'grok-test', object: 'model', created, owned_by: 'hermes-xai-oauth' },
    ],
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m === 'object' && typeof m.content === 'string')
    .map((m) => ({ role: String(m.role ?? 'user'), content: m.content }));
}

function promptFromRequest(body) {
  const messages = normalizeMessages(body.messages);
  const system = typeof body.systemPrompt === 'string'
    ? body.systemPrompt
    : messages.find((m) => m.role === 'system')?.content ?? '';
  const nonSystem = messages.filter((m) => m.role !== 'system');
  const lines = [];
  if (system.trim()) {
    lines.push('System instructions:');
    lines.push(system.trim());
    lines.push('');
  }
  lines.push('Conversation:');
  for (const m of nonSystem) {
    lines.push(`${m.role.toUpperCase()}: ${m.content}`);
  }
  lines.push('');
  lines.push('Reply to the latest user request.');
  return lines.join('\n');
}

function cleanHermesOutput(output) {
  const lines = output.replace(/\r/g, '').split('\n');
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^session_id:\s*/.test(trimmed)) return false;
    return true;
  });
  return filtered.join('\n').trim();
}

function providerFromRequest(body) {
  if (typeof body.provider === 'string' && body.provider.trim()) return body.provider.trim();
  const model = typeof body.model === 'string' ? body.model.toLowerCase() : '';
  if (model.includes('grok') || model.includes('xai')) return 'xai-oauth';
  return PROVIDER;
}

function runHermes(prompt, provider) {
  return new Promise((resolve, reject) => {
    const args = ['--provider', provider, 'chat', '-q', prompt, '-Q'];
    const child = spawn(HERMES_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Hermes timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(cleanHermesOutput(stdout));
        return;
      }
      reject(new Error(`Hermes exited ${code}: ${redact(stderr || stdout).slice(0, 1000)}`));
    });
  });
}

function authorize(req) {
  const auth = req.headers.authorization ?? '';
  return auth === `Bearer ${TOKEN}`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, provider: PROVIDER, mode: 'hermes-subprocess-spike' });
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      if (!authorize(req)) {
        sendJson(res, 401, { error: { message: 'Unauthorized' } });
        return;
      }
      sendOpenAiModels(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (!authorize(req)) {
        sendJson(res, 401, { error: { message: 'Unauthorized' } });
        return;
      }
      const body = await readBody(req);
      const stream = body.stream !== false;
      const provider = providerFromRequest(body);
      const model = typeof body.model === 'string' ? body.model : provider;
      const prompt = promptFromRequest(body);

      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        try {
          const text = await runHermes(prompt, provider);
          sendOpenAiStreamChunk(res, text);
          sendOpenAiStreamDone(res);
        } catch (err) {
          sendOpenAiStreamError(
            res,
            redact(err instanceof Error ? err.message : String(err)).slice(0, 500),
          );
          sendOpenAiStreamDone(res);
        }
        res.end();
        return;
      }

      const text = await runHermes(prompt, provider);
      sendJson(res, 200, {
        id: `hermes-bridge-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      });
      return;
    }

    sendJson(res, 404, { error: { message: 'Not found' } });
  } catch (err) {
    sendJson(res, 500, { error: { message: redact(err instanceof Error ? err.message : String(err)) } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Hermes bridge spike listening on http://${HOST}:${PORT}`);
  console.log(`Provider: ${PROVIDER}`);
});
