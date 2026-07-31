import {
  Controller,
  GetBillingSummaryUseCase,
  HttpRequest,
  HttpResponse,
} from './billing-protocols.js';
import { buildBadRequest } from '../../helpers/http-helper.js';
import { InvalidParamError, MissingParamError } from '../../errors/index.js';
import { toBillingSummaryView } from './billing-view-model.js';
import { BillingSummaryView } from './billing-view-schemas.js';

/**
 * US17: ONE statement-export resource — the representation is a query
 * parameter (`format=csv|html`, default csv), not a separate route
 * (decision 98). Both renderers derive from the SAME statement view the
 * screen shows: a closed month exports its snapshot verbatim; a current
 * month carries the PARCIAL watermark (QA13 — decision 94).
 *
 * - csv  → the US8 drill-down lines; opens straight in Excel (UTF-8 BOM).
 * - html → standalone printable page; the browser's print-to-PDF is the
 *          PDF path in v1 (no binary PDF dependency).
 */
const csvEscape = (value: string): string =>
  /[";\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

const csvLine = (cells: string[]): string => cells.map(csvEscape).join(';');

export const statementCsv = (view: BillingSummaryView): string => {
  const header = [
    csvLine(['Extrato mensal', view.month_label]),
    csvLine(['Status', view.status_label]),
    ...(view.closed_at_display
      ? [csvLine(['Fechado em', view.closed_at_display])]
      : []),
    ...(view.watermark_display
      ? [csvLine(['Atualização', view.watermark_display])]
      : []),
    ...(view.partial ? [csvLine(['ATENÇÃO', 'DADOS PARCIAIS'])] : []),
    csvLine(['Total do mês (R$)', view.total_cost_brl]),
    '',
    csvLine([
      'agente',
      'versao_agente',
      'modelo',
      'tipo_token',
      'tokens',
      'preco_unitario_R$_por_milhao',
      'vigente_desde',
      'custo_exato_R$',
      'custo_exibido_R$',
      ...(view.partial ? ['marca'] : []),
    ]),
  ];

  const lines = view.lines.map((line) =>
    csvLine([
      line.agent_id ?? '(sem agente)',
      line.agent_version ?? '',
      line.model ?? '(sem modelo)',
      line.token_type_label,
      String(line.tokens),
      line.unit_price_brl_per_million_display,
      line.unit_price_effective_from_display,
      line.cost_brl_exact,
      line.cost_brl_display,
      ...(view.partial ? ['PARCIAL'] : []),
    ]),
  );

  const footer = csvLine([
    'TOTAL',
    '',
    '',
    '',
    String(view.stamped_tokens_total),
    '',
    '',
    '',
    view.total_cost_brl,
    ...(view.partial ? ['PARCIAL'] : []),
  ]);

  return [...header, ...lines, footer].join('\r\n');
};

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] as string,
  );

export const statementPrintHtml = (view: BillingSummaryView): string => {
  const linesHtml = view.lines
    .map(
      (line) => `<tr>
        <td>${escapeHtml(line.agent_id ?? '(sem agente)')}${line.agent_version ? ` <small>v${escapeHtml(line.agent_version)}</small>` : ''}</td>
        <td>${escapeHtml(line.model_label)}</td>
        <td>${escapeHtml(line.token_type_label)}</td>
        <td class="num">${escapeHtml(line.tokens_display)}</td>
        <td class="num">${escapeHtml(line.unit_price_brl_per_million_display)}</td>
        <td class="num">${escapeHtml(line.cost_brl_display_brl)}</td>
      </tr>`,
    )
    .join('');

  const agentsHtml = view.agents
    .map(
      (agent) => `<tr>
        <td>${escapeHtml(agent.agent_label)}${agent.version_label ? ` <small>${escapeHtml(agent.version_label)}</small>` : ''}</td>
        <td class="num">${escapeHtml(agent.tokens_total_display)}</td>
        <td class="num">${escapeHtml(agent.percent_of_total_display)}</td>
        <td class="num">${escapeHtml(agent.cost_brl_display)}</td>
      </tr>`,
    )
    .join('');

  const reopenHtml = view.reopen_notes.length
    ? `<p class="note">Reaberturas auditadas: ${view.reopen_notes
        .map((note) => `${escapeHtml(note.at_display)} — ${escapeHtml(note.reason)}`)
        .join(' · ')}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Extrato ${escapeHtml(view.month_label)}</title>
<style>
  body { font-family: system-ui, sans-serif; color: #111; margin: 40px; font-size: 13px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #555; margin-bottom: 24px; }
  .status { display: inline-block; padding: 2px 10px; border-radius: 99px; font-weight: 600; font-size: 11px; }
  .status.final { background: #e7f6ee; color: #067647; }
  .status.partial { background: #fdf3e0; color: #b45309; }
  .hero { font-size: 26px; font-weight: 700; margin: 12px 0 2px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 28px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #666; border-bottom: 1px solid #ccc; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #eee; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  h2 { font-size: 14px; margin: 24px 0 4px; }
  small { color: #777; }
  .note { color: #555; font-size: 11px; }
  .watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: -1; }
  .watermark span { font-size: 110px; font-weight: 800; color: rgba(180, 83, 9, .08); transform: rotate(-28deg); letter-spacing: .1em; }
  @media print { body { margin: 12mm; } }
</style>
</head>
<body>
${view.partial ? '<div class="watermark"><span>PARCIAL</span></div>' : ''}
<h1>Extrato mensal — ${escapeHtml(view.month_label)}</h1>
<div class="meta">
  <span class="status ${view.final ? 'final' : 'partial'}">${escapeHtml(view.status_label)}</span>
  ${view.closed_at_display ? ` · fechado em ${escapeHtml(view.closed_at_display)}` : ''}
  ${view.snapshot_version !== null ? ` · snapshot v${view.snapshot_version}` : ''}
  ${view.watermark_display ? ` · ${escapeHtml(view.watermark_display)}` : ''}
</div>
<div class="hero">${escapeHtml(view.total_cost_brl_display)}</div>
<p class="note">${view.stamped_trace_count} execuções · ${escapeHtml(view.stamped_tokens_total_display)} tokens · valores em R$; partes exibidas fecham exatamente com o total (arredondamento half-up, 2 casas).</p>
${reopenHtml}

<h2>Custo por agente</h2>
<table>
  <thead><tr><th>Agente</th><th class="num">Tokens</th><th class="num">% do total</th><th class="num">Custo</th></tr></thead>
  <tbody>${agentsHtml}</tbody>
</table>

<h2>Linhas do extrato — quantidade × preço contratado = custo</h2>
<table>
  <thead><tr><th>Agente</th><th>Modelo</th><th>Tipo de token</th><th class="num">Tokens</th><th class="num">Preço (R$/M)</th><th class="num">Custo</th></tr></thead>
  <tbody>${linesHtml}</tbody>
</table>

<p class="note">Gerado pela plataforma · ${escapeHtml(view.month_label)} · ${escapeHtml(view.status_label)}. Imprima em PDF pelo navegador (Ctrl+P).</p>
</body>
</html>`;
};

const FORMATS = ['csv', 'html'] as const;

type ExportFormat = (typeof FORMATS)[number];

export class ExportStatementController implements Controller {
  private readonly getBillingSummary: GetBillingSummaryUseCase;

  constructor(args: { getBillingSummary: GetBillingSummaryUseCase }) {
    this.getBillingSummary = args.getBillingSummary;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const query = (httpRequest.query ?? {}) as {
      year?: string;
      month?: string;
      format?: string;
    };

    for (const field of ['year', 'month'] as const) {
      if (!query[field]) {
        return buildBadRequest(new MissingParamError(field));
      }
    }

    const year = Number(query.year);
    const month = Number(query.month);

    if (!Number.isInteger(year) || year < 1970 || year > 9999) {
      return buildBadRequest(new InvalidParamError('year'));
    }

    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return buildBadRequest(new InvalidParamError('month'));
    }

    const format = (query.format ?? 'csv') as ExportFormat;

    if (!FORMATS.includes(format)) {
      return buildBadRequest(new InvalidParamError('format'));
    }

    const view = toBillingSummaryView(
      await this.getBillingSummary.get(year, month),
    );

    if (format === 'html') {
      return {
        statusCode: 200,
        body: statementPrintHtml(view),
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      };
    }

    const filename = `extrato-${year}-${String(month).padStart(2, '0')}${
      view.partial ? '-PARCIAL' : ''
    }.csv`;

    return {
      statusCode: 200,
      // BOM: Excel pt-BR reads the file as UTF-8 (accents survive).
      body: `\ufeff${statementCsv(view)}`,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    };
  }
}
