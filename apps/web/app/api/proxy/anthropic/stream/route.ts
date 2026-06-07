import type { NextRequest } from 'next/server';
import {
  anthropicMessagesUrl,
  errorPayload,
  jsonError,
  normalizedMessages,
  parseJsonBody,
  redactAuthTokens,
  sseResponse,
  validateExternalApiBaseUrl,
} from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await parseJsonBody(req);
  const baseUrl = body.baseUrl;
  const apiKey = body.apiKey;
  const model = body.model;
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : '';

  if (typeof baseUrl !== 'string' || typeof apiKey !== 'string' || typeof model !== 'string') {
    return jsonError(400, 'BAD_REQUEST', 'baseUrl, apiKey, and model are required');
  }

  const validated = validateExternalApiBaseUrl(baseUrl);
  if (validated.error) {
    return jsonError(validated.forbidden ? 403 : 400, validated.forbidden ? 'FORBIDDEN' : 'BAD_REQUEST', validated.error);
  }

  const url = anthropicMessagesUrl(baseUrl);
  const payload = {
    model,
    max_tokens: 8192,
    stream: true,
    system: systemPrompt,
    messages: normalizedMessages(body.messages),
  };

  return sseResponse(async (send, close) => {
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: req.signal,
      });
    } catch (err) {
      send('error', errorPayload('UPSTREAM_UNAVAILABLE', `fetch failed: ${err instanceof Error ? err.message : String(err)}`, { retryable: true }));
      close();
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      const safeErr = redactAuthTokens(errText.slice(0, 500));
      send('error', errorPayload('UPSTREAM_UNAVAILABLE', `upstream ${upstream.status}: ${safeErr}`, { retryable: upstream.status >= 500 }));
      close();
      return;
    }

    send('start', { model });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let match: RegExpMatchArray | null;
      while ((match = buf.match(/\r?\n\r?\n/)) && match.index != null) {
        const frame = buf.slice(0, match.index);
        buf = buf.slice(match.index + match[0].length);
        const raw = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
          .trim();
        if (!raw) continue;
        if (raw === '[DONE]') {
          send('end', {});
          close();
          return;
        }
        try {
          const chunk = JSON.parse(raw) as { type?: string; delta?: { text?: string; partial_json?: string }; error?: { message?: string } };
          if (chunk.type === 'content_block_delta') {
            const text = chunk.delta?.text ?? chunk.delta?.partial_json ?? '';
            if (text) send('delta', { text });
          } else if (chunk.type === 'message_delta') {
            const text = chunk.delta?.text ?? '';
            if (text) send('delta', { text });
          } else if (chunk.type === 'message_stop') {
            send('end', {});
            close();
            return;
          } else if (chunk.type === 'error') {
            send('error', errorPayload('UPSTREAM_UNAVAILABLE', chunk.error?.message || 'upstream error', { retryable: false }));
            close();
            return;
          }
        } catch {
          // Ignore malformed provider frames.
        }
      }
    }

    send('end', {});
    close();
  });
}
