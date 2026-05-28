import { afterEach, describe, expect, it, vi } from 'vitest';

const envHttpProxyAgentConstructor = vi.fn();

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  class MockEnvHttpProxyAgent {
    constructor(options?: unknown) {
      envHttpProxyAgentConstructor(options);
    }

    async close() {}
  }

  return {
    ...actual,
    EnvHttpProxyAgent: MockEnvHttpProxyAgent,
  };
});

describe('proxyDispatcherRequestInit', () => {
  afterEach(() => {
    envHttpProxyAgentConstructor.mockReset();
    vi.resetModules();
  });

  it('forwards agent timeout options into EnvHttpProxyAgent construction', async () => {
    const { proxyDispatcherRequestInit } = await import('../src/connectionTest.js');

    const { close, requestInit } = proxyDispatcherRequestInit(
      {
        HTTP_PROXY: 'http://proxy.example.test:8080',
      },
      {
        headersTimeout: 10 * 60 * 1000,
        bodyTimeout: 10 * 60 * 1000,
      },
    );

    expect(requestInit.dispatcher).toBeTruthy();
    expect(envHttpProxyAgentConstructor).toHaveBeenCalledWith(expect.objectContaining({
      bodyTimeout: 10 * 60 * 1000,
      headersTimeout: 10 * 60 * 1000,
      httpProxy: 'http://proxy.example.test:8080',
      noProxy: 'localhost,127.0.0.1,[::1]',
    }));
    await expect(close()).resolves.toBeUndefined();
  });
});
