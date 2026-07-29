/**
 * Pure rendering layer: every derived or formatted value (totals, money,
 * durations, dates, relative ages, waterfall/bar geometry, groupings,
 * labels, page counts) comes READY from the API — this file only binds
 * fields to the DOM, escapes HTML and toggles visibility.
 */
/* Single-tenant: this UI is deployed INSIDE one client's stack and talks to
   that client's API through the same origin (nginx proxies /api to the api
   service). It knows no client and no host. */
const API_BASE = '/api/v1';
const PAGE_SIZE = 20;

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

/* Static presentation constants (enum → text/color), not data processing. */
const STATUS_LABELS = { ok: 'OK', error: 'Erro' };
const SPAN_COLORS = ['#60a5fa', '#4ade80', '#f472b6', '#fbbf24', '#a78bfa', '#2dd4bf', '#fb923c'];
const TOKEN_TYPE_COLORS = {
  input: 'var(--tk-input)',
  output: 'var(--tk-output)',
  cache_read: 'var(--tk-cache-read)',
  cache_write: 'var(--tk-cache-write)',
};
const TOKEN_TYPE_LABELS = {
  input: 'input',
  output: 'output',
  cache_read: 'cache read',
  cache_write: 'cache write',
};

const statusBadge = (status) => {
  const label = STATUS_LABELS[status];
  if (label === undefined) {
    return `<span class="status status-other">${escapeHtml(status)}</span>`;
  }
  const cssClass = status === 'ok' ? 'status-ok' : 'status-error';
  return `<span class="status ${cssClass}">${label}</span>`;
};

const spanColor = (types, type) =>
  SPAN_COLORS[types.indexOf(type) % SPAN_COLORS.length];

/* Clickable rows are real keyboard targets (role="button" + tabindex="0"):
   Enter/Space triggers the same open handler as click — Space is
   preventDefault'ed so the page does not scroll. */
const onRowActivate = (tbodyEl, selector, handler) => {
  tbodyEl.addEventListener('click', (event) => {
    const row = event.target.closest(selector);
    if (row) handler(row);
  });
  tbodyEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest(selector);
    if (!row) return;
    event.preventDefault();
    handler(row);
  });
};

const errorBox = document.getElementById('error');

/* ---------- Traces list ---------- */

const state = {
  page: 1,
  filters: { domain: '', subdomain: '', type: '', agent: '', status: '' },
};
const tbody = document.getElementById('traces-body');
const totalLabel = document.getElementById('total-label');
const pageLabel = document.getElementById('page-label');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');

const costCellHtml = (item) =>
  item.cost_brl_display != null
    ? escapeHtml(item.cost_brl_display)
    : '<span class="pending">preço pendente</span>';

const renderRow = (trace) => `<tr class="clickable" role="button" tabindex="0" data-trace-id="${escapeHtml(trace.trace_id)}">
    <td class="trace-id">${escapeHtml(trace.trace_id)}</td>
    <td>
      <div class="agent-name">${escapeHtml(trace.agent_label)}</div>
      ${trace.scope_label ? `<div class="agent-sub">${escapeHtml(trace.scope_label)}</div>` : ''}
    </td>
    <td><span class="badge badge-channel">${escapeHtml(trace.channel.type)}</span></td>
    <td>${statusBadge(trace.status)}</td>
    <td class="num">${escapeHtml(trace.duration_display)}</td>
    <td class="num">${escapeHtml(trace.tokens_total_display)}</td>
    <td class="num">${costCellHtml(trace)}</td>
    <td class="num when" title="${escapeHtml(trace.started_at)}">${escapeHtml(trace.age_display)}</td>
  </tr>`;

const render = (data) => {
  totalLabel.textContent = `${data.total_display} traces`;
  pageLabel.textContent = `Página ${data.page} de ${data.total_pages_display}`;
  prevBtn.disabled = data.page <= 1;
  nextBtn.disabled = data.page >= data.total_pages;

  tbody.innerHTML = data.items.length
    ? data.items.map(renderRow).join('')
    : '<tr><td colspan="8" class="empty">Nenhum trace encontrado.</td></tr>';
};

let loadSeq = 0;
let lastGoodPage = 1;
let lastGoodTotalPages = 1;

const load = async (background = false) => {
  const seq = ++loadSeq;
  // Background refreshes (auto-refresh timer) repaint in place: no
  // "Carregando…" placeholder, no button flicker, errors stay silent —
  // the next tick recovers.
  if (!background) {
    errorBox.classList.add('hidden');
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Carregando…</td></tr>';
  }
  try {
    const params = buildTraceFilterParams();
    params.set('page', state.page);
    params.set('page_size', PAGE_SIZE);
    const res = await fetch(`${API_BASE}/traces?${params}`);
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const data = await res.json();
    if (seq !== loadSeq) return;
    lastGoodPage = data.page;
    lastGoodTotalPages = data.total_pages;
    state.page = data.page;
    render(data);
  } catch (err) {
    if (seq !== loadSeq) return;
    if (background) return;
    state.page = lastGoodPage;
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    tbody.innerHTML = '<tr><td colspan="8" class="empty">—</td></tr>';
    errorBox.textContent = `Falha ao carregar traces: ${err.message}. A API do cliente está no ar?`;
    errorBox.classList.remove('hidden');
  }
};

const goToPage = (page) => {
  state.page = Math.max(1, page);
  load();
};

prevBtn.addEventListener('click', () => goToPage(state.page - 1));
nextBtn.addEventListener('click', () =>
  goToPage(Math.min(state.page + 1, lastGoodTotalPages)));

/* ---------- Traces filter bar ---------- */
/* Dropdowns come from GET /traces/filters: stored values + "what-if"
   counts per option, cascading with self-exclusion (the API computes
   everything — this file only binds options to <select>s). */

const FILTER_FIELDS = [
  { key: 'domain', optionsKey: 'domains', label: 'Domínio' },
  { key: 'subdomain', optionsKey: 'subdomains', label: 'Subdomínio' },
  { key: 'type', optionsKey: 'types', label: 'Tipo' },
  { key: 'agent', optionsKey: 'agents', label: 'Agente' },
];

const filterSelects = Object.fromEntries(
  [...FILTER_FIELDS.map((f) => f.key), 'status'].map((key) => [
    key,
    document.getElementById(`filter-${key}`),
  ]),
);

const buildTraceFilterParams = () => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.filters)) {
    if (value) params.set(key, value);
  }
  return params;
};

const optionHtml = (value, text, selected) =>
  `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(text)}</option>`;

const renderFilterSelect = (select, label, options, current, valueLabel) => {
  const parts = [
    optionHtml('', `${label}: todos`, current === ''),
    ...options.map((option) =>
      optionHtml(
        option.value,
        `${label}: ${valueLabel(option.value)} (${option.count})`,
        option.value === current,
      ),
    ),
  ];
  // A selected value can leave the option list when OTHER filters exclude
  // it — keep it selectable so the user can still see and clear it.
  if (current && !options.some((option) => option.value === current)) {
    parts.push(optionHtml(current, `${label}: ${valueLabel(current)} (0)`, true));
  }
  select.innerHTML = parts.join('');
};

const renderFilterOptions = (data) => {
  for (const field of FILTER_FIELDS) {
    renderFilterSelect(
      filterSelects[field.key],
      field.label,
      data[field.optionsKey],
      state.filters[field.key],
      (value) => value,
    );
  }
  renderFilterSelect(
    filterSelects.status,
    'Status',
    data.statuses,
    state.filters.status,
    (value) => STATUS_LABELS[value] ?? value,
  );
};

let filterOptionsSeq = 0;

const loadFilterOptions = async (background = false) => {
  const seq = ++filterOptionsSeq;
  try {
    const res = await fetch(`${API_BASE}/traces/filters?${buildTraceFilterParams()}`);
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const data = await res.json();
    if (seq !== filterOptionsSeq) return;
    // Background refreshes never repaint under a focused select — the
    // dropdown could be open and would snap shut mid-choice. Explicit
    // changes repaint always: the user just closed the dropdown.
    if (
      background &&
      Object.values(filterSelects).includes(document.activeElement)
    ) {
      return;
    }
    renderFilterOptions(data);
  } catch {
    /* Dropdowns keep their last options; the next reload recovers. */
  }
};

for (const [key, select] of Object.entries(filterSelects)) {
  select.addEventListener('change', () => {
    state.filters[key] = select.value;
    state.page = 1;
    load();
    loadFilterOptions();
  });
}

/* ---------- Trace detail side panel ---------- */

const panel = document.getElementById('panel');
const panelContent = document.getElementById('panel-content');
const backdrop = document.getElementById('backdrop');

/* Focus management (a11y): opening the panel moves focus to its close
   button; closing returns it to the opener. Auto-refresh repaints rows,
   so a row opener is remembered as an identity selector (re-queried at
   close), with the raw element as fallback for non-row openers. */
let panelReturn = null;

const rowIdentitySelector = (row) => {
  if (row.dataset.traceId !== undefined)
    return `tr[data-trace-id="${CSS.escape(row.dataset.traceId)}"]`;
  if (row.dataset.sessionId !== undefined)
    return `tr[data-session-id="${CSS.escape(row.dataset.sessionId)}"]`;
  if (row.dataset.year !== undefined)
    return `tr[data-year="${CSS.escape(row.dataset.year)}"][data-month="${CSS.escape(row.dataset.month)}"]`;
  return null;
};

const rememberPanelReturn = () => {
  // In-panel navigation (trace ↔ session links) keeps the original opener.
  if (!panel.classList.contains('hidden')) return;
  const el = document.activeElement;
  const row = el?.closest?.('tr.clickable');
  panelReturn = row
    ? { selector: rowIdentitySelector(row), element: row }
    : { selector: null, element: el };
};

const restorePanelReturn = () => {
  if (!panelReturn) return;
  const { selector, element } = panelReturn;
  panelReturn = null;
  const target =
    (selector && document.querySelector(selector)) ||
    (element && document.contains(element) ? element : null);
  if (target && target.focus) target.focus();
};

/* Every panel render ends here: wire the close button and move focus onto
   it, so keyboard users land inside the freshly opened panel. */
const wirePanelClose = () => {
  const closeBtn = document.getElementById('panel-close');
  closeBtn.addEventListener('click', closePanel);
  closeBtn.focus();
};

const renderStat = (label, valueHtml) => `
  <div class="stat">
    <div class="stat-label">${label}</div>
    <div class="stat-value">${valueHtml}</div>
  </div>`;

const contentBlock = (text) =>
  `<pre class="content-block">${escapeHtml(text)}</pre>`;

const spanIoHtml = (item) =>
  item.input_text != null || item.output_text != null
    ? `<details class="span-io">
        <summary>entrada / saída</summary>
        ${item.input_text != null ? contentBlock(item.input_text) : ''}
        ${item.output_text != null ? contentBlock(item.output_text) : ''}
      </details>`
    : '';

const renderWaterfall = (trace) => {
  if (!trace.spans.length) return '';

  const legend = trace.span_types.map((type) => `
    <span class="legend-chip" style="--chip-color:${spanColor(trace.span_types, type)}">${escapeHtml(type)}</span>
  `).join('');

  const rows = trace.spans.map((span) => {
    const errorMsg = span.status === 'error' && span.error_message
      ? `<span class="span-error-msg">${escapeHtml(span.error_message)}</span>`
      : '';
    return `<div class="span-row">
      <div class="span-name" title="${escapeHtml(span.label)}">${escapeHtml(span.label)}${errorMsg}</div>
      <div class="span-track">
        <div class="span-bar" style="left:${span.waterfall.left_percent}%;width:${span.waterfall.width_percent}%;background:${spanColor(trace.span_types, span.type)}"></div>
      </div>
      <div class="span-ms">${escapeHtml(span.duration_display)}</div>
    </div>${spanIoHtml(span)}`;
  }).join('');

  return `<section class="panel-section">
    <h3 class="section-title">Waterfall de spans
      <span class="section-note">· ${trace.span_count} spans · ${escapeHtml(trace.duration_display)} no total</span>
    </h3>
    <div class="span-legend">${legend}</div>
    ${rows}
  </section>`;
};

const renderCosts = (trace) => {
  if (trace.pricing_status === 'pending_price') {
    return `<section class="panel-section">
      <h3 class="section-title">Custo</h3>
      <p class="pending">Preço pendente — tokens preservados, custo em aberto${
        trace.pending_missing_label ? ` (sem preço para: ${escapeHtml(trace.pending_missing_label)})` : ''}.</p>
    </section>`;
  }
  if (!trace.costs || !trace.costs.length) return '';

  const rows = trace.costs.map((cost) => `<tr>
    <td>${escapeHtml(cost.token_type)}</td>
    <td class="num">${escapeHtml(cost.tokens_display)}</td>
    <td class="num mono">${escapeHtml(cost.applied_price_display)}</td>
    <td class="num mono">${escapeHtml(cost.cost_brl_exact_display)}</td>
  </tr>`).join('');

  return `<section class="panel-section">
    <h3 class="section-title">Custo por tipo de token
      ${trace.costs_effective_from_display ? `<span class="section-note">· preço vigente desde ${escapeHtml(trace.costs_effective_from_display)}</span>` : ''}
    </h3>
    <div class="table-wrap">
      <table class="cost-table">
        <thead><tr>
          <th>Tipo</th><th class="num">Tokens</th>
          <th class="num">Preço aplicado</th><th class="num">Custo exato</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
};

const renderContent = (trace) => {
  if (!trace.content) return '';
  return `
    ${trace.content.input_text != null ? `
      <section class="panel-section">
        <h3 class="section-title">Conteúdo — entrada</h3>
        ${contentBlock(trace.content.input_text)}
      </section>` : ''}
    ${trace.content.output_text != null ? `
      <section class="panel-section">
        <h3 class="section-title">Conteúdo — saída</h3>
        ${contentBlock(trace.content.output_text)}
      </section>` : ''}`;
};

const renderDetail = (trace) => {
  panelContent.innerHTML = `
    <div class="panel-topbar">
      <span class="panel-eyebrow">Trace · ${escapeHtml(trace.type)} · ${escapeHtml(trace.channel.type)}</span>
      <button class="panel-close" id="panel-close" aria-label="Fechar">✕</button>
    </div>
    <div class="panel-trace-id">${escapeHtml(trace.trace_id)}</div>
    <div class="panel-agent-line">
      <span class="agent-name">${escapeHtml(trace.agent_label)}</span>
      ${trace.scope_label ? `<span class="agent-sub">${escapeHtml(trace.scope_label)}</span>` : ''}
    </div>
    <div class="panel-meta">
      ${statusBadge(trace.status)}
      <span title="${escapeHtml(trace.started_at)}">${escapeHtml(trace.started_at_display)} (${escapeHtml(trace.age_display)})</span>
      ${trace.session_id ? `<span>· sessão <button class="chain-trace-link" id="session-link" data-session-id="${escapeHtml(trace.session_id)}">${escapeHtml(trace.session_id)}</button></span>` : ''}
      ${trace.model ? `<span>· modelo <span class="mono">${escapeHtml(trace.model)}</span></span>` : ''}
      ${trace.user_id ? `<span>· usuário <span class="mono">${escapeHtml(trace.user_id)}</span></span>` : ''}
      ${trace.environment ? `<span>· ambiente ${escapeHtml(trace.environment)}</span>` : ''}
      ${trace.experiment ? `<span>· experimento ${escapeHtml(trace.experiment.name)} · variante ${escapeHtml(trace.experiment.variant)}</span>` : ''}
    </div>
    ${trace.unclassified_label ? `
      <p class="pending unclassified">Sem atribuição de agente: ${escapeHtml(trace.unclassified_label)}</p>` : ''}
    <div class="stat-grid">
      ${renderStat('Duração', escapeHtml(trace.duration_display))}
      ${renderStat('Tokens in', escapeHtml(trace.tokens_display.input))}
      ${renderStat('Tokens out', escapeHtml(trace.tokens_display.output))}
      ${trace.tokens.cache_read ? renderStat('Cache read', escapeHtml(trace.tokens_display.cache_read)) : ''}
      ${trace.tokens.cache_write ? renderStat('Cache write', escapeHtml(trace.tokens_display.cache_write)) : ''}
      ${renderStat('Custo', costCellHtml(trace).replace('preço pendente', 'pendente'))}
    </div>
    ${renderWaterfall(trace)}
    ${renderCosts(trace)}
    ${renderContent(trace)}`;

  wirePanelClose();
  const sessionLink = document.getElementById('session-link');
  if (sessionLink) {
    sessionLink.addEventListener('click', () =>
      openSessionPanel(sessionLink.dataset.sessionId),
    );
  }
};

let panelSeq = 0;

const openPanel = async (traceId) => {
  const seq = ++panelSeq;
  rememberPanelReturn();
  panel.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  panelContent.innerHTML = '<p class="empty">Carregando…</p>';
  try {
    const res = await fetch(`${API_BASE}/traces/${encodeURIComponent(traceId)}`);
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const data = await res.json();
    if (seq !== panelSeq) return;
    renderDetail(data);
  } catch (err) {
    if (seq !== panelSeq) return;
    panelContent.innerHTML = `
      <div class="panel-topbar">
        <span class="panel-eyebrow">Trace</span>
        <button class="panel-close" id="panel-close" aria-label="Fechar">✕</button>
      </div>
      <div class="error">Falha ao carregar o trace: ${escapeHtml(err.message)}</div>`;
    wirePanelClose();
  }
};

const closePanel = () => {
  panelSeq += 1;
  panel.classList.add('hidden');
  backdrop.classList.add('hidden');
  restorePanelReturn();
};

onRowActivate(tbody, 'tr[data-trace-id]', (row) => openPanel(row.dataset.traceId));

backdrop.addEventListener('click', closePanel);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePanel();
});

/* ---------- Sessions ---------- */

const sessionsState = { page: 1, filters: { agent: '', status: '' } };

const sessionFilterSelects = {
  agent: document.getElementById('sessions-filter-agent'),
  status: document.getElementById('sessions-filter-status'),
};

const buildSessionFilterParams = () => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sessionsState.filters)) {
    if (value) params.set(key, value);
  }
  return params;
};

/* Dropdowns from GET /sessions/filters (decisão 80): session counts per
   option, cascading with self-exclusion — same contract as the traces
   filter bar. */
let sessionFilterOptionsSeq = 0;

const loadSessionFilterOptions = async (background = false) => {
  const seq = ++sessionFilterOptionsSeq;
  try {
    const res = await fetch(`${API_BASE}/sessions/filters?${buildSessionFilterParams()}`);
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const data = await res.json();
    if (seq !== sessionFilterOptionsSeq) return;
    // Same rule as the traces bar: never repaint under a focused select.
    if (
      background &&
      Object.values(sessionFilterSelects).includes(document.activeElement)
    ) {
      return;
    }
    renderFilterSelect(
      sessionFilterSelects.agent,
      'Agente',
      data.agents,
      sessionsState.filters.agent,
      (value) => value,
    );
    renderFilterSelect(
      sessionFilterSelects.status,
      'Status',
      data.statuses,
      sessionsState.filters.status,
      (value) => STATUS_LABELS[value] ?? value,
    );
  } catch {
    /* Dropdowns keep their last options; the next reload recovers. */
  }
};

for (const [key, select] of Object.entries(sessionFilterSelects)) {
  select.addEventListener('change', () => {
    sessionsState.filters[key] = select.value;
    sessionsState.page = 1;
    loadSessions();
    loadSessionFilterOptions();
  });
}
const sessionsBody = document.getElementById('sessions-body');
const sessionsTotalLabel = document.getElementById('sessions-total-label');
const sessionsPageLabel = document.getElementById('sessions-page-label');
const sessionsPrevBtn = document.getElementById('sessions-prev');
const sessionsNextBtn = document.getElementById('sessions-next');

const sessionCostHtml = (session) => {
  if (session.cost_brl_display != null) return escapeHtml(session.cost_brl_display);
  const partial = session.stamped_cost_brl_partial_display != null
    ? ` <span class="when">(parcial ${escapeHtml(session.stamped_cost_brl_partial_display)})</span>`
    : '';
  return `<span class="pending">pendente</span>${partial}`;
};

const renderSessionRow = (session) => `<tr class="clickable" role="button" tabindex="0" data-session-id="${escapeHtml(session.session_id)}">
    <td class="trace-id">${escapeHtml(session.session_id)}</td>
    <td>
      <div class="agent-name">${escapeHtml(session.agent_label)}</div>
      ${session.scope_label ? `<div class="agent-sub">${escapeHtml(session.scope_label)}</div>` : ''}
    </td>
    <td class="num">${session.trace_count}</td>
    <td>${statusBadge(session.status)}</td>
    <td class="num">${escapeHtml(session.total_duration_display)}</td>
    <td class="num">${escapeHtml(session.tokens_total_display)}</td>
    <td class="num">${sessionCostHtml(session)}</td>
    <td class="num when" title="${escapeHtml(session.last_activity_at)}">${escapeHtml(session.age_display)}</td>
  </tr>`;

const renderSessions = (data) => {
  // Capped-total displays (decisão 77/79), same contract as traces: the
  // label carries the "+", the pager keeps the raw capped numbers.
  sessionsTotalLabel.textContent = `${data.total_display} sessões`;
  sessionsPageLabel.textContent = `Página ${data.page} de ${data.total_pages_display}`;
  sessionsPrevBtn.disabled = data.page <= 1;
  sessionsNextBtn.disabled = data.page >= data.total_pages;

  sessionsBody.innerHTML = data.items.length
    ? data.items.map(renderSessionRow).join('')
    : '<tr><td colspan="8" class="empty">Nenhuma sessão encontrada.</td></tr>';
};

let sessionsLoadSeq = 0;
let sessionsLastGoodPage = 1;
let sessionsLastGoodTotalPages = 1;

const loadSessions = async (background = false) => {
  const seq = ++sessionsLoadSeq;
  if (!background) {
    errorBox.classList.add('hidden');
    sessionsPrevBtn.disabled = true;
    sessionsNextBtn.disabled = true;
    sessionsBody.innerHTML = '<tr><td colspan="8" class="empty">Carregando…</td></tr>';
  }
  try {
    const params = buildSessionFilterParams();
    params.set('page', sessionsState.page);
    params.set('page_size', PAGE_SIZE);
    const res = await fetch(`${API_BASE}/sessions?${params}`);
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const data = await res.json();
    if (seq !== sessionsLoadSeq) return;
    sessionsLastGoodPage = data.page;
    sessionsLastGoodTotalPages = data.total_pages;
    sessionsState.page = data.page;
    renderSessions(data);
  } catch (err) {
    if (seq !== sessionsLoadSeq) return;
    if (background) return;
    sessionsState.page = sessionsLastGoodPage;
    sessionsPrevBtn.disabled = false;
    sessionsNextBtn.disabled = false;
    sessionsBody.innerHTML = '<tr><td colspan="8" class="empty">—</td></tr>';
    errorBox.textContent = `Falha ao carregar sessões: ${err.message}. A API do cliente está no ar?`;
    errorBox.classList.remove('hidden');
  }
};

sessionsPrevBtn.addEventListener('click', () => {
  sessionsState.page = Math.max(1, sessionsState.page - 1);
  loadSessions();
});
sessionsNextBtn.addEventListener('click', () => {
  sessionsState.page = Math.min(sessionsState.page + 1, sessionsLastGoodTotalPages);
  loadSessions();
});

/* Session detail panel */

const renderChainItem = (trace) => `<div class="chain-item">
    <div class="chain-head">
      <button class="chain-trace-link" data-trace-id="${escapeHtml(trace.trace_id)}">${escapeHtml(trace.trace_id)}</button>
      ${statusBadge(trace.status)}
      <span class="when">${escapeHtml(trace.started_at_display)}</span>
      <span class="chain-metrics">${escapeHtml(trace.duration_display)} · ${escapeHtml(trace.tokens_total_display)} tokens · ${costCellHtml(trace).replace('preço pendente', 'pendente')}</span>
    </div>
    ${spanIoHtml(trace)}
  </div>`;

const renderSessionDetail = (session) => {
  panelContent.innerHTML = `
    <div class="panel-topbar">
      <span class="panel-eyebrow">Sessão</span>
      <button class="panel-close" id="panel-close" aria-label="Fechar">✕</button>
    </div>
    <div class="panel-trace-id">${escapeHtml(session.session_id)}</div>
    <div class="panel-agent-line">
      <span class="agent-name">${escapeHtml(session.agent_label)}</span>
      ${session.scope_label ? `<span class="agent-sub">${escapeHtml(session.scope_label)}</span>` : ''}
    </div>
    <div class="panel-meta">
      ${statusBadge(session.status)}
      <span title="${escapeHtml(session.started_at)}">início ${escapeHtml(session.started_at_display)}</span>
      <span>· última atividade ${escapeHtml(session.last_activity_at_display)} (${escapeHtml(session.age_display)})</span>
      ${session.user_id ? `<span>· usuário <span class="mono">${escapeHtml(session.user_id)}</span></span>` : ''}
    </div>
    <div class="stat-grid">
      ${renderStat('Traces', session.trace_count)}
      ${renderStat('Duração total', escapeHtml(session.total_duration_display))}
      ${renderStat('Tokens in', escapeHtml(session.tokens_in_display))}
      ${renderStat('Tokens out', escapeHtml(session.tokens_out_display))}
      ${renderStat('Custo', sessionCostHtml(session))}
    </div>
    ${session.pending_price_count > 0 ? `
      <p class="pending unclassified">${session.pending_price_count} trace(s) com preço pendente — o custo da sessão fica em aberto até o carimbo.</p>` : ''}
    <section class="panel-section">
      <h3 class="section-title">Cadeia de traces
        <span class="section-note">· ordem cronológica · clique para abrir o trace</span>
      </h3>
      ${session.chain.map(renderChainItem).join('')}
      ${session.chain_truncated ? `<div class="empty">Cadeia truncada: exibindo os primeiros ${session.chain.length} traces desta sessão (os totais acima cobrem a sessão inteira).</div>` : ''}
    </section>`;

  wirePanelClose();
  panelContent.querySelectorAll('.chain-trace-link[data-trace-id]').forEach((btn) =>
    btn.addEventListener('click', () => openPanel(btn.dataset.traceId)),
  );
};

const openSessionPanel = async (sessionId) => {
  const seq = ++panelSeq;
  rememberPanelReturn();
  panel.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  panelContent.innerHTML = '<p class="empty">Carregando…</p>';
  try {
    const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const data = await res.json();
    if (seq !== panelSeq) return;
    renderSessionDetail(data);
  } catch (err) {
    if (seq !== panelSeq) return;
    panelContent.innerHTML = `
      <div class="panel-topbar">
        <span class="panel-eyebrow">Sessão</span>
        <button class="panel-close" id="panel-close" aria-label="Fechar">✕</button>
      </div>
      <div class="error">Falha ao carregar a sessão: ${escapeHtml(err.message)}</div>`;
    wirePanelClose();
  }
};

onRowActivate(sessionsBody, 'tr[data-session-id]', (row) =>
  openSessionPanel(row.dataset.sessionId));

/* ---------- Faturas (bills) ---------- */

const billsBody = document.getElementById('bills-body');
const billsTotalLabel = document.getElementById('bills-total-label');

const renderBillPanel = (data) => {
  const legend = Object.entries(TOKEN_TYPE_LABELS).map(([type, label]) =>
    `<span><span class="tk-swatch" style="background:${TOKEN_TYPE_COLORS[type]}"></span>${label}</span>`,
  ).join('');

  const agentGroups = data.agents.map((group) => {
    const segments = group.segments.map((segment) =>
      `<div class="cost-seg" style="width:${segment.width_percent}%;background:${TOKEN_TYPE_COLORS[segment.token_type]}" title="${escapeHtml(segment.label)}"></div>`,
    ).join('');
    const rows = group.lines.map((line) => `<tr>
      <td>${escapeHtml(line.model_label)}</td>
      <td>${escapeHtml(line.token_type)}</td>
      <td class="num">${escapeHtml(line.tokens_display)}</td>
      <td class="num mono">${escapeHtml(line.cost_brl_exact_display)}</td>
      <td class="num">${escapeHtml(line.cost_brl_display_brl)}</td>
    </tr>`).join('');

    return `<details class="agent-cost">
      <summary>
        <span>
          <span class="agent-name">${escapeHtml(group.agent_label)}</span>
          <span class="agent-sub">${group.version_label ? escapeHtml(group.version_label) : ''} · ${escapeHtml(group.tokens_total_display)} tokens</span>
        </span>
        <div class="cost-track">${segments}</div>
        <span class="agent-total">${escapeHtml(group.cost_brl_display)}</span>
      </summary>
      <div class="agent-lines">
        <table class="cost-table">
          <thead><tr>
            <th>Modelo</th><th>Tipo</th><th class="num">Tokens</th>
            <th class="num">Custo exato</th><th class="num">Custo exibido</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
  }).join('');

  panelContent.innerHTML = `
    <div class="panel-topbar">
      <span class="panel-eyebrow">Fatura · extrato do mês</span>
      <button class="panel-close" id="panel-close" aria-label="Fechar">✕</button>
    </div>
    <div class="panel-trace-id">${escapeHtml(data.month_label)}</div>
    <div class="billing-hero">
      <div class="stat">
        <div class="stat-label">Total do mês${data.partial ? ' (parcial)' : ''}</div>
        <div class="stat-value hero">${escapeHtml(data.total_cost_brl_display)}
          ${data.partial ? '<span class="partial-badge">mês em andamento</span>' : ''}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">Tokens carimbados</div>
        <div class="stat-value">${escapeHtml(data.stamped_tokens_total_display)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Agentes</div>
        <div class="stat-value">${data.agent_count}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Modelos</div>
        <div class="stat-value">${data.model_count}</div>
      </div>
    </div>

    ${data.pending_price.trace_count > 0 ? `
      <div class="pending-card">
        <strong>${data.pending_price.trace_count} trace(s) com preço pendente</strong> —
        ${escapeHtml(data.pending_price.tokens_total_display)} tokens fora do total
        (modelos sem preço: ${escapeHtml(data.pending_price.models_label)}).
        O custo entra no mês quando o preço for cadastrado.
      </div>` : ''}

    ${data.agents.length ? `
      <section class="panel-section">
        <h3 class="section-title">Custo por agente
          <span class="section-note">· barra proporcional ao custo · clique para detalhar por modelo e tipo de token</span>
        </h3>
        <div class="tk-legend">${legend}</div>
        ${agentGroups}
      </section>` : '<p class="empty">Nenhum custo carimbado neste mês.</p>'}

    <p class="billing-note">
      Total ≡ soma dos custos carimbados dos traces do mês (uma única fonte de
      verdade). Valores exibidos arredondados half-up em 2 casas; as partes
      exibidas fecham exatamente com o total exibido.
    </p>`;

  wirePanelClose();
};

const openBillPanel = async (year, month) => {
  const seq = ++panelSeq;
  rememberPanelReturn();
  panel.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  panelContent.innerHTML = '<p class="empty">Carregando…</p>';
  try {
    const res = await fetch(`${API_BASE}/billing/summary?year=${year}&month=${month}`);
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const data = await res.json();
    if (seq !== panelSeq) return;
    renderBillPanel(data);
  } catch (err) {
    if (seq !== panelSeq) return;
    panelContent.innerHTML = `
      <div class="panel-topbar">
        <span class="panel-eyebrow">Fatura</span>
        <button class="panel-close" id="panel-close" aria-label="Fechar">✕</button>
      </div>
      <div class="error">Falha ao carregar a fatura: ${escapeHtml(err.message)}</div>`;
    wirePanelClose();
  }
};

const renderBillRow = (bill) => `<tr class="clickable" role="button" tabindex="0" data-year="${bill.year}" data-month="${bill.month}">
  <td class="agent-name">${escapeHtml(bill.month_label)}</td>
  <td>${bill.partial
    ? `<span class="partial-badge">${escapeHtml(bill.status_label)}</span>`
    : `<span class="when">${escapeHtml(bill.status_label)}</span>`}</td>
  <td class="num">${bill.stamped_trace_count}</td>
  <td class="num">${bill.pending_trace_count > 0
    ? `<span class="pending">${bill.pending_trace_count}</span>`
    : '0'}</td>
  <td class="num">${escapeHtml(bill.tokens_display)}</td>
  <td class="num">${escapeHtml(bill.total_cost_brl_display)}${bill.partial ? ' <span class="when">(parcial)</span>' : ''}</td>
</tr>`;

let billsLoadSeq = 0;

const loadBills = async () => {
  const seq = ++billsLoadSeq;
  errorBox.classList.add('hidden');
  billsBody.innerHTML = '<tr><td colspan="6" class="empty">Carregando…</td></tr>';
  try {
    const res = await fetch(`${API_BASE}/bills`);
    if (!res.ok) throw new Error(`API respondeu ${res.status}`);
    const data = await res.json();
    if (seq !== billsLoadSeq) return;
    billsTotalLabel.textContent = `${data.bills.length} fatura(s)`;
    billsBody.innerHTML = data.bills.length
      ? data.bills.map(renderBillRow).join('')
      : '<tr><td colspan="6" class="empty">Nenhuma fatura.</td></tr>';
  } catch (err) {
    if (seq !== billsLoadSeq) return;
    billsBody.innerHTML = '<tr><td colspan="6" class="empty">—</td></tr>';
    errorBox.textContent = `Falha ao carregar faturas: ${err.message}. A API do cliente está no ar?`;
    errorBox.classList.remove('hidden');
  }
};

onRowActivate(billsBody, 'tr[data-year]', (row) =>
  openBillPanel(row.dataset.year, row.dataset.month));

/* ---------- Tabs ---------- */

const TABS = {
  traces: {
    button: document.getElementById('tab-traces'),
    view: document.getElementById('view-traces'),
  },
  sessions: {
    button: document.getElementById('tab-sessions'),
    view: document.getElementById('view-sessions'),
    loadOnce: () => {
      loadSessions();
      loadSessionFilterOptions();
    },
  },
  billing: {
    button: document.getElementById('tab-billing'),
    view: document.getElementById('view-billing'),
    loadOnce: loadBills,
  },
};

const activateTab = (name) => {
  for (const [key, tab] of Object.entries(TABS)) {
    tab.button.classList.toggle('active', key === name);
    tab.button.setAttribute('aria-selected', key === name ? 'true' : 'false');
    tab.view.classList.toggle('hidden', key !== name);
  }
  errorBox.classList.add('hidden');
  closePanel();
  const tab = TABS[name];
  if (tab.loadOnce) {
    const { loadOnce } = tab;
    delete tab.loadOnce;
    loadOnce();
  }
};

for (const [name, tab] of Object.entries(TABS)) {
  tab.button.addEventListener('click', () => activateTab(name));
}

/* Deployment identity: /client.json is served by this stack's nginx with the
   client name from the env. Cosmetic — absence (e.g. serving the files
   outside a deployment) just leaves the badge hidden. */
fetch('/client.json')
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => {
    if (!data?.client) return;
    document.getElementById('client-name').textContent = data.client;
    document.title = `${data.client} — Plataforma`;
  })
  .catch(() => {});

load();
loadFilterOptions();

/* ---------- Auto-refresh ---------- */
/* The trace-ingestion-worker ingests continuously, so the ACTIVE list keeps itself
   fresh: silent background reloads (in-place repaint, no placeholder
   flicker, errors skipped — the next tick recovers). Paused while the
   browser tab is hidden. Billing stays manual — monthly aggregates don't
   move on a 5s scale. */
const AUTO_REFRESH_MS = 5000;

setInterval(() => {
  if (document.hidden) return;
  if (TABS.traces.button.classList.contains('active')) {
    load(true);
    loadFilterOptions(true);
  } else if (TABS.sessions.button.classList.contains('active')) {
    // First visit loads via loadOnce; only refresh once that has run.
    if (!TABS.sessions.loadOnce) {
      loadSessions(true);
      loadSessionFilterOptions(true);
    }
  }
}, AUTO_REFRESH_MS);
