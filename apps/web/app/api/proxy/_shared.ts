import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type SseController = ReadableStreamDefaultController<Uint8Array>;

const encoder = new TextEncoder();

export function sseResponse(start: (send: (event: string, data: unknown) => void, close: () => void) => Promise<void> | void): Response {
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        writeSse(controller, event, data);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      try {
        await start(send, close);
      } catch (err) {
        send('error', errorPayload('PROXY_ERROR', err instanceof Error ? err.message : String(err), { retryable: false }));
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

function writeSse(controller: SseController, event: string, data: unknown) {
  controller.enqueue(encoder.encode(`event: ${event}\n`));
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(data ?? {})}\n\n`));
}

export function errorPayload(code: string, message: string, extra?: Record<string, unknown>) {
  return { code, message: redactAuthTokens(message), ...(extra ?? {}) };
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function redactAuthTokens(text: string): string {
  return text.replace(/Bearer [A-Za-z0-9_\-.+/=]+/g, 'Bearer [REDACTED]');
}

export function validateExternalApiBaseUrl(baseUrl: unknown): { parsed?: URL; error?: string; forbidden?: boolean } {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return { error: 'Invalid baseUrl' };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.replace(/\/+$/, ''));
  } catch {
    return { error: 'Invalid baseUrl' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'Only http/https allowed' };
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.startsWith('169.254.') ||
    host.startsWith('10.') ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return { error: 'Internal hosts blocked', forbidden: true };
  }
  return { parsed };
}

export function openAiChatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(clean) ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(clean) ? `${clean}/messages` : `${clean}/v1/messages`;
}

export async function parseJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

export function normalizedMessages(value: unknown): { role: 'user' | 'assistant'; content: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => {
      return Boolean(m) && typeof m === 'object' && (m as { role?: unknown }).role !== undefined &&
        ((m as { role?: unknown }).role === 'user' || (m as { role?: unknown }).role === 'assistant') &&
        typeof (m as { content?: unknown }).content === 'string';
    })
    .map((m) => ({ role: m.role, content: m.content }));
}
