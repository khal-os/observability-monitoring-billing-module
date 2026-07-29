import { z } from 'zod';
import { apiErrorSchema } from '../../presentation/helpers/docs-schemas.js';
import {
  traceDetailResponseSchema,
  traceFilterOptionsResponseSchema,
  traceListResponseSchema,
} from '../../presentation/controllers/traces/trace-view-schemas.js';
import {
  sessionDetailResponseSchema,
  sessionListResponseSchema,
} from '../../presentation/controllers/sessions/session-view-schemas.js';
import {
  billListResponseSchema,
  billingSummaryResponseSchema,
} from '../../presentation/controllers/billing/billing-view-schemas.js';

/**
 * The OpenAPI document is GENERATED from the presentation-layer response
 * schemas (zod → JSON Schema 2020-12, native to OpenAPI 3.1) — the same
 * strict schemas the contract tests parse real responses with. Docs,
 * validation and code share one source of truth; drift fails the suite.
 */
const toSchema = (schema: z.ZodType) => z.toJSONSchema(schema);

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: toSchema(apiErrorSchema) } },
});

const okResponse = (description: string, schema: z.ZodType) => ({
  description,
  content: { 'application/json': { schema: toSchema(schema) } },
});

const queryParam = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  required = false,
) => ({ name, in: 'query', description, required, schema });

/** Multi-value filter: repeat the param for OR (?agent=a&agent=b). */
const listQueryParam = (name: string, description: string) => ({
  name,
  in: 'query',
  description,
  required: false,
  schema: { type: 'array', items: { type: 'string' } },
  style: 'form',
  explode: true,
});

const pathParam = (name: string, description: string) => ({
  name,
  in: 'path',
  description,
  required: true,
  schema: { type: 'string' },
});

const paginationParams = [
  queryParam('page', 'Página (1-based).', { type: 'integer', minimum: 1, default: 1 }),
  queryParam('page_size', 'Itens por página (máx. 100).', {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
  }),
];

const periodParams = [
  queryParam('from', 'Início do período (inclusivo, ISO 8601, UTC).', {
    type: 'string',
    format: 'date-time',
  }),
  queryParam('to', 'Fim do período (exclusivo, ISO 8601, UTC).', {
    type: 'string',
    format: 'date-time',
  }),
];

/** Shared by GET /traces and GET /traces/filters (decision 76). */
const traceFilterParams = [
  ...periodParams,
  listQueryParam('agent', 'Ids de agente (repita o parâmetro para OR).'),
  queryParam('status', 'Status de execução.', {
    type: 'string',
    enum: ['ok', 'error'],
  }),
  listQueryParam('type', 'Tipos de trace (repita o parâmetro para OR).'),
  listQueryParam(
    'channel',
    'Tipos de canal (whatsapp/web/...; repita o parâmetro para OR).',
  ),
  listQueryParam(
    'domain',
    'Domínios (match exato; repita o parâmetro para OR).',
  ),
  listQueryParam(
    'subdomain',
    'Subdomínios (match exato; repita o parâmetro para OR).',
  ),
  queryParam('search', 'Busca exata por id de trace OU de sessão.', {
    type: 'string',
  }),
];

export const buildOpenApiDocument = (clientName?: string) => ({
  openapi: '3.1.0',
  info: {
    // The deployment's client name (env-injected) brands the docs of this
    // single-tenant instance; without it, the generic module title.
    title: clientName
      ? `Módulo de Observabilidade — ${clientName.toUpperCase()}`
      : 'Módulo de Observabilidade — API',
    version: '0.1.0',
    description:
      'Uma API, três faces: Billing (quanto custou), Traces (as execuções ' +
      'reais) e Sessions (as conversas). Todos os valores client-facing são ' +
      'em R$; custos vêm do carimbo de preço aplicado na ingestão (imutável). ' +
      'Traces sem preço aplicável aparecem como pending_price — nunca R$ 0,00.',
  },
  tags: [
    { name: 'Traces', description: 'Execuções reais por trás dos números.' },
    { name: 'Sessions', description: 'Conversas: traces agrupados por sessão (read-model derivado).' },
    { name: 'Billing', description: 'Agregados mensais — soma dos custos carimbados, por construção.' },
  ],
  paths: {
    '/api/v1/traces': {
      get: {
        tags: ['Traces'],
        summary: 'Lista traces (recente primeiro)',
        description:
          'Totais LIMITADOS (decisão 77): com filtros, a contagem para em ' +
          '10.000 — `total_capped: true` e displays com sufixo "+" ' +
          '("10.000+"). Sem filtros o total é exato.',
        parameters: [...traceFilterParams, ...paginationParams],
        responses: {
          '200': okResponse('Página de traces.', traceListResponseSchema),
          '400': errorResponse('Parâmetro de consulta inválido.'),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/traces/filters': {
      get: {
        tags: ['Traces'],
        summary: 'Opções dos dropdowns de filtro (valores armazenados + contagens)',
        description:
          'Valores distintos por campo filtrável (incluindo statuses), com ' +
          'contagem por opção, servidos pelo cubo de contadores mantido na ' +
          'ingestão (decisão 77). Cascata com auto-exclusão: as opções do ' +
          'campo X honram todos os filtros EXCETO o do próprio X — um ' +
          'dropdown selecionado continua listando suas alternativas. Cada ' +
          'contagem é um "e se": traces que casariam com aquele valor ' +
          'combinado aos filtros dos OUTROS campos. Período (from/to) é ' +
          'arredondado PARA FORA em dias UTC inteiros neste endpoint; a ' +
          'listagem mantém timestamps exatos.',
        parameters: [...traceFilterParams],
        responses: {
          '200': okResponse(
            'Opções por campo.',
            traceFilterOptionsResponseSchema,
          ),
          '400': errorResponse('Parâmetro de consulta inválido.'),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/traces/{id}': {
      get: {
        tags: ['Traces'],
        summary: 'Anatomia completa de um trace',
        description:
          'Métricas, blocos de agente/canal (build e instância que serviram a ' +
          'execução), spans ordenados, conteúdo integral e a conta do custo ' +
          '(preço aplicado × tokens, precisão cheia por linha).',
        parameters: [pathParam('id', 'Id do trace.')],
        responses: {
          '200': okResponse('Trace completo.', traceDetailResponseSchema),
          '404': errorResponse('Trace não encontrado.'),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/sessions': {
      get: {
        tags: ['Sessions'],
        summary: 'Lista sessões (conversas)',
        description:
          'Período filtra pelo INÍCIO da sessão (QA17). Sessão com traces ' +
          'pendentes de preço expõe cost_brl null + parcial — nunca um total ' +
          'que se leia como R$ 0,00 final.',
        parameters: [
          ...periodParams,
          queryParam('agent', 'Filtra pelo id do agente da sessão.', {
            type: 'string',
          }),
          queryParam('status', 'error se QUALQUER trace da sessão falhou.', {
            type: 'string',
            enum: ['ok', 'error'],
          }),
          ...paginationParams,
        ],
        responses: {
          '200': okResponse('Página de sessões.', sessionListResponseSchema),
          '400': errorResponse('Parâmetro de consulta inválido.'),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/sessions/{id}': {
      get: {
        tags: ['Sessions'],
        summary: 'Sessão com a cadeia cronológica de traces',
        parameters: [pathParam('id', 'Id da sessão.')],
        responses: {
          '200': okResponse('Agregados + cadeia (transcrição).', sessionDetailResponseSchema),
          '404': errorResponse('Sessão não encontrada.'),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/bills': {
      get: {
        tags: ['Billing'],
        summary: 'Lista faturas (recente primeiro)',
        description:
          'Uma fatura por mês-calendário (UTC) com ao menos um trace. ' +
          'Total ≡ soma dos carimbos do mês; pendentes contados à parte, ' +
          'fora do total. Mês corrente sempre parcial (in_progress).',
        responses: {
          '200': okResponse('Faturas.', billListResponseSchema),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
    '/api/v1/billing/summary': {
      get: {
        tags: ['Billing'],
        summary:
          'Extrato do mês: total + quebra agente × versão × modelo × tipo de token',
        description:
          'Total ≡ soma dos custos carimbados dos traces do mês (checado por ' +
          'teste automatizado). Linhas exibidas fecham com o total exibido ' +
          '(largest remainder). Pendentes reportados à parte, fora do total.',
        parameters: [
          queryParam('year', 'Calendar year (UTC), e.g. 2026.', {
            type: 'integer',
            minimum: 1970,
            maximum: 9999,
          }, true),
          queryParam('month', 'Calendar month (1-12, UTC).', {
            type: 'integer',
            minimum: 1,
            maximum: 12,
          }, true),
        ],
        responses: {
          '200': okResponse('Resumo do mês.', billingSummaryResponseSchema),
          '400': errorResponse('Ano/mês ausentes ou malformados.'),
          '500': errorResponse('Erro interno.'),
        },
      },
    },
  },
});
