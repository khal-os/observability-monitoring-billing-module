import {
  Controller,
  HttpRequest,
  HttpResponse,
  RegisterPriceVersionUseCase,
} from './prices-protocols.js';
import {
  buildBadRequest,
  buildConflict,
  buildCreated,
} from '../../helpers/http-helper.js';
import {
  ConflictError,
  InvalidParamError,
  MissingParamError,
} from '../../errors/index.js';
import { DuplicatePriceVersionError } from '../../../domain/errors/duplicate-price-version-error.js';
import {
  brlToMicrocents,
  formatBrlExactFromMicrocents,
} from '../../../common/helpers/money/money.js';
import {
  formatBrlDisplay,
  formatUtcDateDisplay,
} from '../../../common/helpers/display/display.js';
import {
  RegisterPriceVersionResponse,
  registerPriceVersionRequestSchema,
} from './price-view-schemas.js';

export class RegisterPriceVersionController implements Controller {
  private readonly registerPriceVersion: RegisterPriceVersionUseCase;

  constructor(args: { registerPriceVersion: RegisterPriceVersionUseCase }) {
    this.registerPriceVersion = args.registerPriceVersion;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = registerPriceVersionRequestSchema.safeParse(
      httpRequest.body ?? {},
    );

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const body = (httpRequest.body ?? {}) as Record<string, unknown>;

      // Strict contract: an unknown key fails loudly on ITS name — a typoed
      // field silently ignored is how a wrong price gets registered.
      if (issue?.code === 'unrecognized_keys') {
        return buildBadRequest(
          new InvalidParamError(issue.keys[0] ?? 'body'),
        );
      }

      // House rule: absent field → MissingParamError; wrong shape →
      // InvalidParamError on that field.
      const paramName = String(issue?.path[0] ?? 'body');

      return buildBadRequest(
        body[paramName] === undefined
          ? new MissingParamError(paramName)
          : new InvalidParamError(paramName),
      );
    }

    try {
      const registered = await this.registerPriceVersion.register({
        model: parsed.data.model,
        tokenType: parsed.data.token_type,
        priceMicrocentsPerMillion: brlToMicrocents(
          parsed.data.price_brl_per_million,
        ),
        effectiveFrom: parsed.data.effective_from,
      });

      const body: RegisterPriceVersionResponse = {
        model: registered.model,
        token_type: registered.tokenType,
        price_brl_per_million: formatBrlExactFromMicrocents(
          registered.priceMicrocentsPerMillion,
        ),
        price_display: `${formatBrlDisplay(
          formatBrlExactFromMicrocents(registered.priceMicrocentsPerMillion),
        )}/M`,
        effective_from: registered.effectiveFrom.toISOString(),
        effective_from_display: formatUtcDateDisplay(registered.effectiveFrom),
        reprocess: {
          examined: registered.reprocess.examined,
          stamped: registered.reprocess.stamped,
          still_pending: registered.reprocess.stillPending,
          failed: registered.reprocess.failed,
          blocked_closed_month: registered.reprocess.blockedClosedMonth,
        },
      };

      return buildCreated(body);
    } catch (error) {
      // Invariant 9 answered as HTTP: versions are immutable — a duplicate
      // (model, tokenType, effectiveFrom) is a 409, register a new
      // effective-from instead.
      if (error instanceof DuplicatePriceVersionError) {
        return buildConflict(new ConflictError(error.message));
      }

      throw error;
    }
  }
}
