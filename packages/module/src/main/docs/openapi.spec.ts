import { buildOpenApiDocument } from './openapi.js';

describe('buildOpenApiDocument()', () => {
  it('MUST brand the title with the UPPERCASED deployment client name', () => {
    expect(buildOpenApiDocument('hapvida').info.title).toBe(
      'M\u00f3dulo de Observabilidade \u2014 HAPVIDA',
    );
  });

  it('MUST fall back to the generic module title without a client name', () => {
    expect(buildOpenApiDocument().info.title).toBe(
      'M\u00f3dulo de Observabilidade \u2014 API',
    );
  });

  // Re-audit iteration 3 (decision 116): the count cap became unconditional
  // (`totalCapped = rawTotal > TOTAL_CAP`, mongodb-trace-query-repository)
  // and the published description kept promising "Sem filtros o total \u00e9
  // exato" \u2014 an integrator sizing the archive from `total` stays pinned at
  // 10.000 forever, with no error. The doc must state the cap for BOTH
  // branches, so the next cap change cannot silently re-open the gap.
  it('MUST NOT promise an exact unfiltered total on GET /traces', () => {
    const description = (
      buildOpenApiDocument().paths['/api/v1/traces'] as {
        get: { description: string };
      }
    ).get.description;

    expect(description).not.toMatch(/[Ss]em filtros o total \u00e9 exato/);
    expect(description).toMatch(/COM ou SEM filtros/);
    expect(description).toContain('total_display');
  });
});
