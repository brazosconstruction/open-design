import type { AppConfig } from './types';

export const HERMES_BRIDGE_API_KEY_SENTINEL = '__open_design_managed_hermes_bridge__';
export const HERMES_BRIDGE_DEFAULT_MODEL = 'gpt-5.5';

export function normalizeHermesBridgeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function configuredHermesBridgeBaseUrl(): string {
  return normalizeHermesBridgeBaseUrl(
    process.env.NEXT_PUBLIC_OD_HERMES_BRIDGE_BASE_URL ?? '',
  );
}

export function isHermesBridgeHardwired(): boolean {
  return configuredHermesBridgeBaseUrl().length > 0;
}

export function withHardwiredHermesBridgeConfig(config: AppConfig): AppConfig {
  const baseUrl = configuredHermesBridgeBaseUrl();
  if (!baseUrl) return config;

  return {
    ...config,
    mode: 'api',
    apiKey: HERMES_BRIDGE_API_KEY_SENTINEL,
    baseUrl,
    model: HERMES_BRIDGE_DEFAULT_MODEL,
    apiProtocol: 'openai',
    apiProviderBaseUrl: null,
  };
}
