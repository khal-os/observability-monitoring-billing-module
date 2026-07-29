import {
  PriceVersionRepository,
  RegisterPriceVersionInput,
  RegisterPriceVersionUseCase,
  RegisteredPriceVersion,
  ReprocessPendingUseCase,
} from './register-price-version-protocols.js';
import {
  modelKey,
  parseModelRef,
} from '../../../domain/models/model-ref.js';

/**
 * THE single registration path for a price version — the HTTP endpoint and
 * the runbook job (`npm run price:insert`) share it verbatim, so the two
 * doors cannot diverge on canonicalization or on the immediate reprocess
 * (same one-path rule as ingestSourceTrace).
 *
 * DuplicatePriceVersionError propagates untouched (invariant 9): callers
 * answer it their own way (HTTP 409 / CLI exit code).
 */
export class RegisterPriceVersionToDbUseCase
  implements RegisterPriceVersionUseCase
{
  private readonly priceVersionRepository: PriceVersionRepository;
  private readonly reprocessPending: ReprocessPendingUseCase;

  constructor(args: {
    priceVersionRepository: PriceVersionRepository;
    reprocessPending: ReprocessPendingUseCase;
  }) {
    this.priceVersionRepository = args.priceVersionRepository;
    this.reprocessPending = args.reprocessPending;
  }

  async register(
    input: RegisterPriceVersionInput,
  ): Promise<RegisteredPriceVersion> {
    // Same canonical key the stamper looks up (decision 82): a price
    // registered under a bare id lands under `provider/id` and matches.
    const canonicalModel = modelKey(parseModelRef(input.model));

    await this.priceVersionRepository.insertVersion({
      model: canonicalModel,
      tokenType: input.tokenType,
      priceMicrocentsPerMillion: input.priceMicrocentsPerMillion,
      effectiveFrom: input.effectiveFrom,
      marketPriceUsd: input.marketPriceUsd,
      ptaxReference: input.ptaxReference,
      markupPercent: input.markupPercent,
    });

    // Decision 57: stamp what the new price unblocks NOW; the worker's
    // periodic sweep stays as backstop.
    const reprocess = await this.reprocessPending.reprocess();

    return {
      model: canonicalModel,
      tokenType: input.tokenType,
      priceMicrocentsPerMillion: input.priceMicrocentsPerMillion,
      effectiveFrom: input.effectiveFrom,
      reprocess,
    };
  }
}
