import { ModelRef } from './model-ref.js';
import { UnclassifiedInfo } from './trace-model.js';

/**
 * THE single definition of the unclassified rule (T3): identity is the
 * agent id; version/instance are optional enrichment and never unclassify
 * a trace. Exported so repository adapters that recompute the flag after
 * an attribution merge use the exact same conditions and reason strings —
 * never a hand-copied duplicate.
 */
export const deriveUnclassified = (args: {
  agentId: string | undefined;
  model: ModelRef | undefined;
}): UnclassifiedInfo | undefined => {
  const reasons: string[] = [];

  if (!args.agentId) {
    reasons.push('missing agentId');
  }

  if (!args.model) {
    reasons.push('missing model');
  }

  return reasons.length > 0 ? { reasons } : undefined;
};
