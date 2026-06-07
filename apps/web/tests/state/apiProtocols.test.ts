import { describe, expect, it } from 'vitest';

import { SUGGESTED_MODELS_BY_PROTOCOL } from '../../src/state/apiProtocols';
import { KNOWN_PROVIDERS } from '../../src/state/config';

describe('OpenAI-compatible BYOK model suggestions', () => {
  it('includes the Hermes bridge Codex model in the OpenAI suggestions', () => {
    expect(SUGGESTED_MODELS_BY_PROTOCOL.openai).toContain('gpt-5.5');
  });

  it('includes the Hermes bridge Codex model in the OpenAI quick-fill provider list', () => {
    const openAiProvider = KNOWN_PROVIDERS.find(
      (provider) => provider.label === 'OpenAI' && provider.protocol === 'openai',
    );

    expect(openAiProvider?.models).toContain('gpt-5.5');
  });
});
