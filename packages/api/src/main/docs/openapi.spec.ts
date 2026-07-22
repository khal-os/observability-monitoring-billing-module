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
});
