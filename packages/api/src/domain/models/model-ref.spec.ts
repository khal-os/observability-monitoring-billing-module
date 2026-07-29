import { modelKey, parseModelRef } from './model-ref.js';

describe('ModelRef (structured model, string only at the borders)', () => {
  it('MUST split provider-prefixed ids (trace-source API format)', () => {
    expect(parseModelRef('anthropic/claude-sonnet-5')).toEqual({
      id: 'claude-sonnet-5',
      provider: 'anthropic',
    });
    expect(parseModelRef('openai/gpt-5-mini')).toEqual({
      id: 'gpt-5-mini',
      provider: 'openai',
    });
    expect(parseModelRef('meta/llama-4-scout')).toEqual({
      id: 'llama-4-scout',
      provider: 'meta',
    });
  });

  it('MUST split on the FIRST slash only (router-style nested ids)', () => {
    expect(parseModelRef('openrouter/google/gemini-2.5-pro')).toEqual({
      id: 'google/gemini-2.5-pro',
      provider: 'openrouter',
    });
  });

  it('MUST infer the provider of bare ids from well-known prefixes', () => {
    expect(parseModelRef('gemini-2.5-pro')).toEqual({
      id: 'gemini-2.5-pro',
      provider: 'google',
    });
    expect(parseModelRef('claude-haiku-4-5')).toEqual({
      id: 'claude-haiku-4-5',
      provider: 'anthropic',
    });
  });

  it('MUST keep the id and a null provider when nothing is inferable (honesty over guessing)', () => {
    expect(parseModelRef('totally-unknown-model')).toEqual({
      id: 'totally-unknown-model',
      provider: null,
    });
  });

  it('MUST not treat edge slashes as a provider separator', () => {
    expect(parseModelRef('/gpt-5-mini')).toEqual({
      id: '/gpt-5-mini',
      provider: null,
    });
    expect(parseModelRef('openai/')).toEqual({
      id: 'openai/',
      provider: null,
    });
  });

  it('modelKey MUST recompose provider/id, or the bare id without provider', () => {
    expect(modelKey({ id: 'claude-sonnet-5', provider: 'anthropic' })).toBe(
      'anthropic/claude-sonnet-5',
    );
    expect(modelKey({ id: 'mystery-model', provider: null })).toBe(
      'mystery-model',
    );
  });

  it('parse → key MUST round-trip prefixed source strings unchanged (wire compatibility)', () => {
    for (const source of [
      'anthropic/claude-sonnet-5',
      'openai/gpt-5-mini',
      'meta/llama-4-scout',
      'openrouter/google/gemini-2.5-pro',
    ]) {
      expect(modelKey(parseModelRef(source))).toBe(source);
    }
  });
});
