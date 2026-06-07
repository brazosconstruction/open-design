import { afterEach, describe, expect, it, vi } from 'vitest';

import { HERMES_BRIDGE_API_KEY_SENTINEL } from '../../../../src/hermesBridge';
import { POST } from '../../../../app/api/proxy/openai/stream/route';

const bridgeBaseUrl = 'https://bridge.example.com';

function request(body: Record<string, unknown>): Request {
  return new Request('https://designer.example/api/proxy/openai/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function sseResponse(...frames: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(new TextEncoder().encode(frame));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('OpenAI proxy route managed Hermes bridge credentials', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('replaces the public sentinel with the server-only bridge token for the configured bridge URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_OD_HERMES_BRIDGE_BASE_URL', `${bridgeBaseUrl}/`);
    vi.stubEnv('OD_HERMES_BRIDGE_TOKEN', 'server-bridge-token');
    const fetchMock = vi.fn(async () => sseResponse(
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
      'data: [DONE]\n\n',
    ));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request({
      baseUrl: bridgeBaseUrl,
      apiKey: HERMES_BRIDGE_API_KEY_SENTINEL,
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'test' }],
    }) as any);
    await response.text();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${bridgeBaseUrl}/v1/chat/completions`);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer server-bridge-token' });
    expect(JSON.stringify(init)).not.toContain(HERMES_BRIDGE_API_KEY_SENTINEL);
  });

  it('rejects the sentinel when the base URL does not match the configured bridge URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_OD_HERMES_BRIDGE_BASE_URL', bridgeBaseUrl);
    vi.stubEnv('OD_HERMES_BRIDGE_TOKEN', 'server-bridge-token');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request({
      baseUrl: 'https://attacker.example.com',
      apiKey: HERMES_BRIDGE_API_KEY_SENTINEL,
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'test' }],
    }) as any);

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps normal BYOK credentials unchanged', async () => {
    const fetchMock = vi.fn(async () => sseResponse('data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-user-key',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'test' }],
    }) as any);
    await response.text();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-user-key' });
  });
});
