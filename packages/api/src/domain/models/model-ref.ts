/**
 * The model that served a trace, as the system carries it INTERNALLY:
 * a structured `{ id, provider }` — never a loose string. The wire string
 * (`provider/id`) is a PROJECTION computed by `modelKey` at the borders
 * (client payloads, price-table lookups), keeping full compatibility with
 * the source format while the domain stays structured.
 *
 * Source formats observed (QA14):
 * - The trace-source HTTP API delivers `provider/model-id`
 *   (e.g. `anthropic/claude-sonnet-5`, `openai/gpt-5-mini`).
 * - The ClickHouse adapter reads raw `gen_ai.*.model` attributes, which
 *   may be a bare model id (e.g. `gemini-2.5-pro`) — the provider is then
 *   inferred from well-known id prefixes, or null when unknown.
 */
export interface ModelRef {
  id: string;
  provider: string | null;
}

const PROVIDER_BY_ID_PREFIX: [RegExp, string][] = [
  [/^claude/, 'anthropic'],
  [/^(gpt|chatgpt|o\d)/, 'openai'],
  [/^(gemini|gemma)/, 'google'],
  [/^llama/, 'meta'],
  [/^(mistral|mixtral|ministral|codestral)/, 'mistral'],
  [/^deepseek/, 'deepseek'],
  [/^grok/, 'xai'],
  [/^qwen/, 'alibaba'],
  [/^command/, 'cohere'],
  [/^(nova|titan)/, 'amazon'],
];

const inferProvider = (modelId: string): string | null =>
  PROVIDER_BY_ID_PREFIX.find(([prefix]) => prefix.test(modelId))?.[1] ?? null;

/**
 * Parses a source model string into the structured ref. Split on the
 * FIRST slash only (router-style ids keep their nested path as the id);
 * bare ids get a best-effort provider, or null — honesty over guessing.
 */
export const parseModelRef = (model: string): ModelRef => {
  const slash = model.indexOf('/');

  if (slash > 0 && slash < model.length - 1) {
    return {
      id: model.slice(slash + 1),
      provider: model.slice(0, slash).toLowerCase(),
    };
  }

  return { id: model, provider: inferProvider(model.toLowerCase()) };
};

/**
 * The canonical string form (`provider/id`, or the bare id when the
 * provider is unknown) — the ONE key used for the wire payload, the
 * price-table lookup and the billing grouping, so all three stay
 * consistent by construction.
 */
export const modelKey = (model: ModelRef): string =>
  model.provider ? `${model.provider}/${model.id}` : model.id;
