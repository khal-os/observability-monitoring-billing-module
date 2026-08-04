import { ExportStatementController } from './export-statement-controller.js';
import {
  BillingSummary,
  GetBillingSummaryUseCase,
} from './billing-protocols.js';
import { InvalidParamError, MissingParamError } from '../../errors/index.js';
import { apiErrorSchema } from '../../helpers/docs-schemas.js';
import { BillingPeriodStateError } from '@observability/core/domain/useCases/close-billing-period-use-case.js';
import { buildStatement } from '../../../application/useCases/billingStatement/statement-engine.js';
import {
  usageRecord,
} from '@observability/core/application/testSupport/billing-test-fakes.js';
import { BillingUsageRecord } from '@observability/core/domain/models/billing-snapshot-model.js';

/**
 * US17 through the wire (M3): the PARCIAL watermark discipline (QA13 —
 * decision 94), the CSV envelope Excel opens, and the escaping that keeps
 * agent-controlled source-trace metadata from becoming formulas (A-4) or
 * markup (XSS) in the exported artifacts.
 */
const record = (
  overrides: Partial<BillingUsageRecord> & { traceId: string },
): BillingUsageRecord =>
  usageRecord({
    stampedCosts: [
      {
        tokenType: 'input',
        tokens: 1_000_000,
        appliedPriceMicrocentsPerMillion: 2_500_000_000,
        appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        costMicrocents: 2_500_000_000,
      },
    ],
    totalCostMicrocents: 2_500_000_000,
    ...overrides,
  });

const makeSummary = (
  overrides?: Partial<BillingSummary> & { records?: BillingUsageRecord[] },
): BillingSummary => {
  const { records, ...summaryOverrides } = overrides ?? {};

  return {
    year: 2026,
    month: 6,
    periodStatus: 'in_progress',
    statement: buildStatement(records ?? [record({ traceId: 't-1' })]),
    pendingPrice: { traceCount: 0, tokens: {}, models: [] },
    ingestionWatermark: null,
    reopenNotes: [],
    quarantinedTraceCount: 0,
    noMeasuredUsageTraceCount: 0,
    comparison: null,
    ...summaryOverrides,
  };
};

/** The real use case's future-month rejection message (audit B-10.3). */
const FUTURE_MONTH_MESSAGE =
  'O mês 2099-01 está no futuro — não há nada a faturar.';

class GetBillingSummaryStub implements GetBillingSummaryUseCase {
  summary: BillingSummary = makeSummary();

  async get(year: number, _month: number): Promise<BillingSummary> {
    // Same period-state rejection the use case raises, so the export's
    // mapping is exercised against the REAL error type.
    if (year === 2099) {
      throw new BillingPeriodStateError(FUTURE_MONTH_MESSAGE);
    }

    return this.summary;
  }
}

const makeSut = () => {
  const getBillingSummaryStub = new GetBillingSummaryStub();
  const sut = new ExportStatementController({
    getBillingSummary: getBillingSummaryStub,
  });

  return { sut, getBillingSummaryStub };
};

const csvQuery = { year: '2026', month: '6', format: 'csv' };
const htmlQuery = { year: '2026', month: '6', format: 'html' };

describe('ExportStatementController', () => {
  describe('Validation (C-3: strict query)', () => {
    it('MUST return 400 for a missing year/month (house MissingParamError)', async () => {
      const { sut } = makeSut();

      const noYear = await sut.handle({ query: { month: '6' } });
      const noMonth = await sut.handle({ query: { year: '2026' } });

      expect(noYear.statusCode).toBe(400);
      expect(noYear.body).toEqual(new MissingParamError('year'));
      expect(noMonth.statusCode).toBe(400);
      expect(noMonth.body).toEqual(new MissingParamError('month'));
    });

    it('MUST return 400 for format=banana', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({
        query: { year: '2026', month: '6', format: 'banana' },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('format'));
    });

    it('MUST return 400 for an unknown query param — never silently ignored', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({
        query: { ...csvQuery, foo: 'x' },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('foo'));
    });

    it('MUST refuse a FUTURE month in BOTH representations with a {name, msg} body', async () => {
      const { sut } = makeSut();

      const future = { year: '2099', month: '1' };
      const csv = await sut.handle({ query: { ...csvQuery, ...future } });
      const html = await sut.handle({ query: { ...htmlQuery, ...future } });

      for (const httpResponse of [csv, html]) {
        expect(httpResponse.statusCode).toBe(400);

        // The wire body — own-enumerable properties only, exactly what
        // res.json() emits. The raw domain Error carried `name` alone.
        const wireBody = JSON.parse(JSON.stringify(httpResponse.body));

        expect(wireBody).toEqual({
          name: 'InvalidParamError',
          msg: FUTURE_MONTH_MESSAGE,
        });
        expect(() => apiErrorSchema.parse(wireBody)).not.toThrow();
      }
    });
  });

  describe('PARCIAL watermark (US6/QA13 — a provisional number never passes for final)', () => {
    it('MUST watermark an in_progress month: HTML span, CSV markers and -PARCIAL filename', async () => {
      const { sut } = makeSut();

      const html = await sut.handle({ query: htmlQuery });
      const csv = await sut.handle({ query: csvQuery });

      expect(html.statusCode).toBe(200);
      expect(html.body as string).toContain(
        '<div class="watermark"><span>PARCIAL</span></div>',
      );

      expect(csv.statusCode).toBe(200);
      const csvBody = csv.body as string;
      expect(csvBody).toContain('ATENÇÃO;DADOS PARCIAIS');
      // Every data line carries the marca column.
      expect(csvBody).toContain(';PARCIAL');
      expect(csv.headers?.['Content-Disposition']).toBe(
        'attachment; filename="extrato-2026-06-PARCIAL.csv"',
      );
    });

    it('MUST NOT watermark a closed month — snapshot verbatim, final filename', async () => {
      const { sut, getBillingSummaryStub } = makeSut();
      getBillingSummaryStub.summary = makeSummary({
        periodStatus: 'closed',
        closedAt: new Date('2026-07-01T03:00:00.000Z'),
        snapshotVersion: 1,
        snapshotVersions: [
          { version: 1, createdAt: new Date('2026-07-01T03:00:00.000Z') },
        ],
      });

      const html = await sut.handle({ query: htmlQuery });
      const csv = await sut.handle({ query: csvQuery });

      expect(html.body as string).not.toContain('PARCIAL');
      expect(csv.body as string).not.toContain('PARCIAL');
      expect(csv.headers?.['Content-Disposition']).toBe(
        'attachment; filename="extrato-2026-06.csv"',
      );
    });
  });

  describe('CSV envelope', () => {
    it('MUST open straight in Excel: UTF-8 BOM, ;-separated, attachment headers', async () => {
      const { sut } = makeSut();

      const csv = await sut.handle({ query: csvQuery });
      const body = csv.body as string;

      // UTF-8 BOM first — Excel pt-BR reads the accents right.
      expect(body.charCodeAt(0)).toBe(0xfeff);
      expect(csv.headers?.['Content-Type']).toBe('text/csv; charset=utf-8');

      const lines = body.slice(1).split('\r\n');
      expect(lines[0]).toBe('Extrato mensal;junho de 2026');
      // The US8 column header row is present, ;-separated.
      expect(body).toContain(
        'agente;versao_agente;modelo;tipo_token;tokens;preco_unitario_R$_por_milhao;vigente_desde;custo_exato_R$;custo_exibido_R$',
      );
      // TOTAL footer closes the file.
      expect(lines[lines.length - 1].startsWith('TOTAL;')).toBe(true);
    });
  });

  describe('Hostile agent/model names (A-4 — source metadata is agent-controlled)', () => {
    const hostileRecords = [
      record({
        traceId: 't-hostile-1',
        agentId: '=cmd(),x',
        agentVersion: null,
        model: '<script>alert(1)</script>',
      }),
      record({
        traceId: 't-hostile-2',
        agentId: 'agent;normal',
        agentVersion: null,
        model: 'mo;del "x"\r\nrest',
      }),
    ];

    it('MUST neutralize formula-leading cells with the OWASP quote prefix in the CSV', async () => {
      const { sut, getBillingSummaryStub } = makeSut();
      getBillingSummaryStub.summary = makeSummary({ records: hostileRecords });

      const csv = await sut.handle({ query: csvQuery });
      const body = csv.body as string;

      // The formula never starts a cell: it is prefixed with a quote…
      expect(body).toContain("'=cmd(),x");
      // …and no cell begins with the bare formula.
      expect(body).not.toMatch(/[;\n]=cmd/);
    });

    it('MUST quote cells carrying the separator, quotes or CR/LF so rows never break', async () => {
      const { sut, getBillingSummaryStub } = makeSut();
      getBillingSummaryStub.summary = makeSummary({ records: hostileRecords });

      const csv = await sut.handle({ query: csvQuery });
      const body = csv.body as string;

      expect(body).toContain('"agent;normal"');
      // Embedded quotes doubled, literal \r\n kept INSIDE the quoted cell.
      expect(body).toContain('"mo;del ""x""\r\nrest"');
    });

    it('MUST HTML-escape every metadata sink in the printable statement', async () => {
      const { sut, getBillingSummaryStub } = makeSut();
      getBillingSummaryStub.summary = makeSummary({ records: hostileRecords });

      const html = await sut.handle({ query: htmlQuery });
      const body = html.body as string;

      expect(body).not.toContain('<script>alert(1)</script>');
      expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });
  });

  describe('Statement lines (B-10.6)', () => {
    it('MUST carry the vigente-desde column in the HTML table, like the CSV', async () => {
      const { sut } = makeSut();

      const html = await sut.handle({ query: htmlQuery });
      const body = html.body as string;

      expect(body).toContain('<th>Vigente desde</th>');
      expect(body).toContain('<td>01/06/2026</td>');
    });
  });
});
