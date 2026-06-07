import type { NextRequest } from 'next/server';
import {
  errorPayload,
  jsonError,
  normalizedMessages,
  openAiChatCompletionsUrl,
  parseJsonBody,
  redactAuthTokens,
  sseResponse,
  validateExternalApiBaseUrl,
} from '../_shared';

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

  const url = openAiChatCompletionsUrl(baseUrl);
  const isMiMo = model.toLowerCase().startsWith('mimo');
  const payload = {
    model,
    max_tokens: 8192,
    stream: true,
    ...(isMiMo ? { tool_choice: 'none', tools: [] } : {}),
    messages: [
      { role: 'system', content: systemPrompt },
      ...normalizedMessages(body.messages),
    ],
  };

  return sseResponse(async (send, close) => {
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') {
          send('end', {});
          close();
          return;
        }
        try {
          const chunk = JSON.parse(raw) as { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ function?: { name?: string } }> } }> };
          const delta = chunk.choices?.[0]?.delta;
          const text = delta?.content ?? '';
          if (text) send('delta', { text });
          for (const tc of delta?.tool_calls ?? []) {
            if (tc.function?.name) send('delta', { text: `\n\n[${tc.function.name}]\n` });
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
