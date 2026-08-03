/**
 * Pure rendering layer: every derived or formatted value (totals, money,
 * durations, dates, relative ages, waterfall/bar geometry, groupings,
 * labels, page counts) comes READY from the API — this file only binds
 * fields to the DOM, escapes HTML and toggles visibility.
 * Binding discipline: string-ish values pass through escapeHtml; values
 * assumed numeric (geometry percents, counts, years/months, versions) are
 * coerced with Number() at bind time, so schema drift can never reach an
 * attribute, style or URL context unescaped.
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

/* Shared JSON fetch: non-OK answers throw with the HTTP status attached.
   A 401 means the platform auth gate is ON (AUTH_SYSTEM_URL set) and this
   UI has no token mechanism yet — its message says exactly that, instead
   of reading like an API outage. Limitation: the export links in the bill
   panel are plain <a href> downloads, outside this helper — under auth
   they surface the server's raw 401. */
const AUTH_401_MESSAGE =
  'Autenticação ativa — esta UI ainda não envia token. ' +
  'Acesse via um cliente autenticado ou desative AUTH_SYSTEM_URL.';

const fetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    const error = new Error(
      res.status === 401 ? AUTH_401_MESSAGE : `API respondeu ${res.status}`,
    );
    error.status = res.status;
    throw error;
  }
  return res.json();
};

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

/* A row survives an innerHTML repaint only as data, never as an element —
   its identity selector re-finds the re-rendered counterpart. Shared by
   the detail panel's return-focus and the auto-refresh focus keeper. */
const rowIdentitySelector = (row) => {
  if (row.dataset.traceId !== undefined)
    return `tr[data-trace-id="${CSS.escape(row.dataset.traceId)}"]`;
  if (row.dataset.sessionId !== undefined)
    return `tr[data-session-id="${CSS.escape(row.dataset.sessionId)}"]`;
  if (row.dataset.year !== undefined)
    return `tr[data-year="${CSS.escape(row.dataset.year)}"][data-month="${CSS.escape(row.dataset.month)}"]`;
  return null;
};

/* Background (auto-refresh) repaints swap tbody innerHTML, which would
   silently drop keyboard focus from a focused row (role="button") to
   <body>. Capture the focused row's identity before the swap and re-focus
   its re-rendered counterpart after; a row no longer in the result set
   loses focus silently — there is no equivalent element to focus. */
const repaintKeepingRowFocus = (tbodyEl, repaint) => {
  const active = document.activeElement;
  const row = tbodyEl.contains(active) ? active.closest('tr.clickable') : null;
  const selector = row ? rowIdentitySelector(row) : null;
  repaint();
  if (!selector) return;
  const target = tbodyEl.querySelector(selector);
  if (target) target.focus();
};

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

/* short: compact pending label for dense contexts (stat grid, chain). */
const costCellHtml = (item, { short = false } = {}) =>
  item.cost_brl_display != null
    ? escapeHtml(item.cost_brl_display)
    : `<span class="pending">${short ? 'pendente' : 'preço pendente'}</span>`;

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
    const data = await fetchJson(`${API_BASE}/traces?${params}`);
    if (seq !== loadSeq) return;
    lastGoodPage = data.page;
    lastGoodTotalPages = data.total_pages;
    state.page = data.page;
    repaintKeepingRowFocus(tbody, () => render(data));
  } catch (err) {
    if (seq !== loadSeq) return;
    if (background) return;
    state.page = lastGoodPage;
    // Mirror the success-path pager logic: Prev stays disabled on page 1,
    // Next past the last known page — an error must not unlock them.
    prevBtn.disabled = lastGoodPage <= 1;
    nextBtn.disabled = lastGoodPage >= lastGoodTotalPages;
    tbody.innerHTML = '<tr><td colspan="8" class="empty">—</td></tr>';
    errorBox.textContent = err.status === 401
      ? err.message
      : `Falha ao carregar traces: ${err.message}. A API do cliente está no ar?`;
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
    const data = await fetchJson(`${API_BASE}/traces/filters?${buildTraceFilterParams()}`);
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

/* label is plain text (escaped here); valueHtml is HTML the caller has
   already escaped or coerced. */
const renderStat = (label, valueHtml) => `
  <div class="stat">
    <div class="stat-label">${escapeHtml(label)}</div>
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
        <div class="span-bar" style="left:${Number(span.waterfall.left_percent)}%;width:${Number(span.waterfall.width_percent)}%;background:${spanColor(trace.span_types, span.type)}"></div>
      </div>
      <div class="span-ms">${escapeHtml(span.duration_display)}</div>
    </div>${spanIoHtml(span)}`;
  }).join('');

  return `<section class="panel-section">
    <h3 class="section-title">Waterfall de spans
      <span class="section-note">· ${Number(trace.span_count)} spans · ${escapeHtml(trace.duration_display)} no total</span>
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
      ${renderStat('Custo', costCellHtml(trace, { short: true }))}
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

/* Opening the dialog is a state change, not a render: it must own focus
   from the first frame, NOT from whenever the fetch resolves. The loading
   state therefore carries the same topbar the loaded and error states carry
   — one focusable control — so wirePanelClose() moves focus inside at open
   time and trapPanelFocus() has something to cycle onto. Without it the
   whole load window (a detail is one findOne over every span plus the full
   unmasked content, invariant 6 — hundreds of ms is normal) left focus on
   the row behind an aria-modal dialog, and Tab silently walked the page
   under an opaque backdrop.
   Returns the panel sequence this opener owns (stale-response guard). */
const openPanelShell = (ariaLabel, eyebrow) => {
  const seq = ++panelSeq;
  rememberPanelReturn();
  panel.setAttribute('aria-label', ariaLabel);
  panel.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  panelContent.innerHTML = `
    <div class="panel-topbar">
      <span class="panel-eyebrow">${eyebrow}</span>
      <button class="panel-close" id="panel-close" aria-label="Fechar">✕</button>
    </div>
    <p class="empty">Carregando…</p>`;
  wirePanelClose();
  return seq;
};

const openPanel = async (traceId) => {
  const seq = openPanelShell('Detalhe do trace', 'Trace');
  try {
    const data = await fetchJson(`${API_BASE}/traces/${encodeURIComponent(traceId)}`);
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

/* Modal semantics (role="dialog" aria-modal="true"): while the panel is
   open, Tab and Shift+Tab cycle among its focusable controls and never
   reach the page underneath; Escape closes. The offsetParent filter drops
   controls hidden inside collapsed <details>. */
const trapPanelFocus = (event) => {
  const focusables = [...panel.querySelectorAll(
    'button, a[href], select, input, textarea, summary, [tabindex]:not([tabindex="-1"])',
  )].filter((el) => el.offsetParent !== null);
  /* Belt and braces: with no focusable descendant, returning would let the
     browser's native Tab move focus to the page BEHIND the backdrop —
     outside an aria-modal dialog, invisible to the user. Park focus on the
     dialog itself instead (#panel carries tabindex="-1"). */
  if (!focusables.length) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (event.shiftKey) {
    if (active === first || !panel.contains(active)) {
      event.preventDefault();
      last.focus();
    }
  } else if (active === last || !panel.contains(active)) {
    event.preventDefault();
    first.focus();
  }
};

document.addEventListener('keydown', (event) => {
  if (panel.classList.contains('hidden')) return;
  if (event.key === 'Escape') closePanel();
  if (event.key === 'Tab') trapPanelFocus(event);
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
    const data = await fetchJson(`${API_BASE}/sessions/filters?${buildSessionFilterParams()}`);
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
    <td class="num">${Number(session.trace_count)}</td>
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
    const data = await fetchJson(`${API_BASE}/sessions?${params}`);
    if (seq !== sessionsLoadSeq) return;
    sessionsLastGoodPage = data.page;
    sessionsLastGoodTotalPages = data.total_pages;
    sessionsState.page = data.page;
    repaintKeepingRowFocus(sessionsBody, () => renderSessions(data));
  } catch (err) {
    if (seq !== sessionsLoadSeq) return;
    if (background) return;
    sessionsState.page = sessionsLastGoodPage;
    // Mirror the success-path pager logic — an error must not unlock it.
    sessionsPrevBtn.disabled = sessionsLastGoodPage <= 1;
    sessionsNextBtn.disabled = sessionsLastGoodPage >= sessionsLastGoodTotalPages;
    sessionsBody.innerHTML = '<tr><td colspan="8" class="empty">—</td></tr>';
    errorBox.textContent = err.status === 401
      ? err.message
      : `Falha ao carregar sessões: ${err.message}. A API do cliente está no ar?`;
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
      <span class="chain-metrics">${escapeHtml(trace.duration_display)} · ${escapeHtml(trace.tokens_total_display)} tokens · ${costCellHtml(trace, { short: true })}</span>
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
      ${renderStat('Traces', Number(session.trace_count))}
      ${renderStat('Duração total', escapeHtml(session.total_duration_display))}
      ${renderStat('Tokens in', escapeHtml(session.tokens_in_display))}
      ${renderStat('Tokens out', escapeHtml(session.tokens_out_display))}
      ${renderStat('Custo', sessionCostHtml(session))}
    </div>
    ${session.pending_price_count > 0 ? `
      <p class="pending unclassified">${Number(session.pending_price_count)} trace(s) com preço pendente — o custo da sessão fica em aberto até o carimbo.</p>` : ''}
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
  const seq = openPanelShell('Detalhe da sessão', 'Sessão');
  try {
    const data = await fetchJson(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}`);
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

/* ---------- Faturas (bills + extrato T7) ---------- */

const billsBody = document.getElementById('bills-body');
const billsTotalLabel = document.getElementById('bills-total-label');

/* Presentation constant (like SPAN_COLORS): slice colors for the model mix
   donut — geometry (start/end percents) comes ready from the API. */
const MIX_COLORS = ['#a78bfa', '#60a5fa', '#4ade80', '#fbbf24', '#f472b6', '#2dd4bf', '#fb923c', '#8f867b'];

const statusPillHtml = (data) => {
  if (data.final) return `<span class="final-badge">${escapeHtml(data.status_label)}</span>`;
  if (data.partial) return `<span class="partial-badge" style="margin-left:0">${escapeHtml(data.status_label)}</span>`;
  return `<span class="open-badge">${escapeHtml(data.status_label)}</span>`;
};

const deltaClass = (direction) =>
  direction === 'up' ? 'delta-up' : direction === 'down' ? 'delta-down' : 'delta-flat';

const renderComparison = (comparison) => {
  if (!comparison) return '';
  const agentRows = comparison.by_agent.map((agent) => `<tr>
    <td>${escapeHtml(agent.agent_label)}${agent.version_label ? ` <span class="agent-sub">${escapeHtml(agent.version_label)}</span>` : ''}</td>
    <td class="num">${escapeHtml(agent.previous_cost_brl_display)}</td>
    <td class="num">${escapeHtml(agent.current_cost_brl_display)}</td>
    <td class="num ${deltaClass(agent.direction)}">${escapeHtml(agent.delta_brl_display)}${agent.delta_percent_display ? ` (${escapeHtml(agent.delta_percent_display)})` : ''}</td>
  </tr>`).join('');

  return `<section class="panel-section">
    <h3 class="section-title">Vs. ${escapeHtml(comparison.previous_month_label)}
      <span class="section-note">· informativo${comparison.previous_partial ? ' · mês anterior parcial' : ''}</span>
    </h3>
    <div class="comparison-card">
      <span>Mês anterior: <b>${escapeHtml(comparison.previous_total_cost_brl_display)}</b></span>
      · variação <b class="${deltaClass(comparison.direction)}">${escapeHtml(comparison.delta_brl_display)}${comparison.delta_percent_display ? ` (${escapeHtml(comparison.delta_percent_display)})` : ''}</b>
      <table class="comparison-table">
        <thead><tr><th>Agente</th><th class="num">Anterior</th><th class="num">Atual</th><th class="num">Δ</th></tr></thead>
        <tbody>${agentRows}</tbody>
      </table>
    </div>
  </section>`;
};

/* One color per MODEL, assigned from the total mix (which contains every
   model of the month) — the same model paints the same color in every
   donut, total and per agent alike. */
const buildMixColorOf = (totalShares) => {
  const colors = new Map(
    totalShares.map((share, index) => [
      share.model_label,
      MIX_COLORS[index % MIX_COLORS.length],
    ]),
  );
  return (label) => colors.get(label) ?? MIX_COLORS[MIX_COLORS.length - 1];
};

const donutHtml = (shares, colorOf) => {
  if (!shares.length) return '';
  const stops = shares.map((share) =>
    `${colorOf(share.model_label)} ${Number(share.donut_start_percent)}% ${Number(share.donut_end_percent)}%`,
  ).join(', ');
  // Money first (pedido do Matheus): each model's R$ and its slice of the
  // MONTH'S COST — token share stays available in the API, not shown here.
  const legend = shares.map((share) => `<div class="mix-legend-item">
      <i style="background:${colorOf(share.model_label)}"></i>
      <span>${escapeHtml(share.model_label)}</span>
      <span class="mix-tokens">${escapeHtml(share.cost_brl_display)}</span>
      <span class="mix-share">${escapeHtml(share.cost_share_percent_display)}</span>
    </div>`).join('');

  return `<div class="mix-wrap">
    <div class="mix-donut" style="background:conic-gradient(${stops})"></div>
    <div class="mix-legend">${legend}</div>
  </div>`;
};

/* ONE donut: each agent's slice of the month cost — above the model mix. */
const renderAgentMix = (agentMix) => {
  if (!agentMix.length) return '';

  const stops = agentMix.map((slice, index) =>
    `${MIX_COLORS[index % MIX_COLORS.length]} ${Number(slice.donut_start_percent)}% ${Number(slice.donut_end_percent)}%`,
  ).join(', ');
  const legend = agentMix.map((slice, index) => `<div class="mix-legend-item">
      <i style="background:${MIX_COLORS[index % MIX_COLORS.length]}"></i>
      <span>${escapeHtml(slice.agent_label)}</span>
      <span class="mix-tokens">${escapeHtml(slice.cost_brl_display)}</span>
      <span class="mix-share">${escapeHtml(slice.cost_share_percent_display)}</span>
    </div>`).join('');

  return `<section class="panel-section">
    <h3 class="section-title">Participação por agente
      <span class="section-note">· quanto do custo do mês cada agente representa</span>
    </h3>
    <div class="mix-wrap">
      <div class="mix-donut" style="background:conic-gradient(${stops})"></div>
      <div class="mix-legend">${legend}</div>
    </div>
  </section>`;
};

const renderModelMix = (mix) => {
  if (!mix.total.length) return '';
  const colorOf = buildMixColorOf(mix.total);

  return `<section class="panel-section">
    <h3 class="section-title">Mix de modelos
      <span class="section-note">· participação no custo do mês (US15)</span>
    </h3>
    ${donutHtml(mix.total, colorOf)}
  </section>`;
};

const renderCacheSavings = (cache) => {
  if (cache.cache_read_tokens === 0 && cache.cache_write_cost_brl_display === 'R$ 0,00') {
    return '';
  }

  return `<section class="panel-section">
    <h3 class="section-title">Economia de cache
      <span class="section-note">· contrafactual aos preços contratados (QA7: escrita explícita)</span>
    </h3>
    <div class="cache-card">
      <div class="cache-grid">
        <div><div class="stat-label">Cache leitura</div>${escapeHtml(cache.cache_read_tokens_display)} tokens</div>
        <div><div class="stat-label">Custo real (leitura)</div>${escapeHtml(cache.actual_cache_read_cost_brl_display)}</div>
        <div><div class="stat-label">Se fosse input normal</div>${escapeHtml(cache.counterfactual_input_cost_brl_display)}</div>
        <div><div class="stat-label">Economia bruta</div>${escapeHtml(cache.savings_brl_display)}</div>
        <div><div class="stat-label">Cache escrita (custo real)</div>${escapeHtml(cache.cache_write_cost_brl_display)}</div>
        <div><div class="stat-label">Economia líquida</div>
          <span class="${cache.net_positive ? 'savings-positive' : 'savings-negative'}">${escapeHtml(cache.net_savings_brl_display)}</span>
        </div>
      </div>
      <p class="billing-note" style="margin-top:10px">${escapeHtml(cache.basis_text)}${
        cache.unpriceable_cache_read_traces > 0
          ? ` ${Number(cache.unpriceable_cache_read_traces)} trace(s) com cache read sem preço de input carimbado ficaram fora do contrafactual.`
          : ''}</p>
    </div>
  </section>`;
};

const renderBillPanel = (data) => {
  const legend = Object.entries(TOKEN_TYPE_LABELS).map(([type, label]) =>
    `<span><span class="tk-swatch" style="background:${TOKEN_TYPE_COLORS[type]}"></span>${label}</span>`,
  ).join('');

  const agentGroups = data.agents.map((group) => {
    const segments = group.segments.map((segment) =>
      `<div class="cost-seg" style="width:${Number(segment.width_percent)}%;background:${TOKEN_TYPE_COLORS[segment.token_type]}" title="${escapeHtml(segment.label)}"></div>`,
    ).join('');
    // US8: every line shows quantidade × preço contratado = custo.
    const rows = group.lines.map((line) => `<tr>
      <td>${escapeHtml(line.model_label)}</td>
      <td>${escapeHtml(line.token_type_label)}</td>
      <td class="num">${escapeHtml(line.tokens_display)}</td>
      <td class="num mono" title="vigente desde ${escapeHtml(line.unit_price_effective_from_display)}">${escapeHtml(line.unit_price_brl_per_million_display)}</td>
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
        <span class="agent-total">${escapeHtml(group.cost_brl_display)}
          <span class="agent-share">${escapeHtml(group.percent_of_total_display)}</span>
        </span>
      </summary>
      <div class="agent-lines">
        <table class="cost-table">
          <thead><tr>
            <th>Modelo</th><th>Tipo</th><th class="num">Tokens</th>
            <th class="num">Preço (R$/M)</th>
            <th class="num">Custo exato</th><th class="num">Custo exibido</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
  }).join('');

  const reopenNotes = data.reopen_notes.map((note) =>
    `<div class="reopen-note">Reaberto em ${escapeHtml(note.at_display)} — ${escapeHtml(note.reason)}</div>`,
  ).join('');

  const versions = data.snapshot_versions.length > 1
    ? `<span>· versões: ${data.snapshot_versions.map((version) =>
        `v${Number(version.version)} (${escapeHtml(version.created_at_display)})`).join(', ')}</span>`
    : '';

  const exportQuery = `year=${Number(data.year)}&month=${Number(data.month)}`;

  panelContent.innerHTML = `
    <div class="panel-topbar">
      <span class="panel-eyebrow">Fatura · extrato do mês</span>
      <button class="panel-close" id="panel-close" aria-label="Fechar">✕</button>
    </div>
    <div class="panel-trace-id">${escapeHtml(data.month_label)}</div>
    <div class="panel-meta">
      ${statusPillHtml(data)}
      ${data.closed_at_display ? `<span>fechado em ${escapeHtml(data.closed_at_display)}${data.snapshot_version !== null ? ` · snapshot v${Number(data.snapshot_version)}` : ''}</span>` : ''}
      ${versions}
      ${data.watermark_display ? `<span>· ${escapeHtml(data.watermark_display)}</span>` : ''}
    </div>
    ${reopenNotes}

    <div class="export-row">
      <a class="export-btn" href="${API_BASE}/billing/statement?${exportQuery}&format=csv" download>⬇ CSV${data.partial ? ' (parcial)' : ''}</a>
      <a class="export-btn" href="${API_BASE}/billing/statement?${exportQuery}&format=html" target="_blank" rel="noopener">🖨 Imprimir / PDF</a>
    </div>

    <div class="billing-hero">
      <div class="stat">
        <div class="stat-label">Total do mês${data.partial ? ' (parcial)' : data.final ? ' (final)' : ''}</div>
        <div class="stat-value hero">${escapeHtml(data.total_cost_brl_display)}
          ${data.partial ? '<span class="partial-badge">mês em andamento</span>' : ''}
        </div>
      </div>
      <div class="stat">
        <div class="stat-label">Execuções</div>
        <div class="stat-value">${Number(data.stamped_trace_count)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Tokens carimbados</div>
        <div class="stat-value">${escapeHtml(data.stamped_tokens_total_display)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Agentes</div>
        <div class="stat-value">${Number(data.agent_count)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Modelos</div>
        <div class="stat-value">${Number(data.model_count)}</div>
      </div>
    </div>

    ${data.pending_price.trace_count > 0 ? `
      <div class="pending-card">
        <strong>${Number(data.pending_price.trace_count)} trace(s) com preço pendente</strong> —
        ${escapeHtml(data.pending_price.tokens_total_display)} tokens fora do total
        (modelos sem preço: ${escapeHtml(data.pending_price.models_label)}).
        O custo entra no mês quando o preço for cadastrado.
      </div>` : ''}

    ${data.quarantined_trace_count > 0 ? `
      <div class="pending-card">
        <strong>${Number(data.quarantined_trace_count)} trace(s) em quarentena</strong> —
        chegaram DEPOIS do fechamento do mês. Ficam fora da fatura congelada;
        entram só via reabertura auditada (runbook).
      </div>` : ''}

    ${data.agents.length ? `
      <section class="panel-section">
        <h3 class="section-title">Custo por agente
          <span class="section-note">· % do total · clique para ver a conta: quantidade × preço = custo</span>
        </h3>
        <div class="tk-legend">${legend}</div>
        ${agentGroups}
      </section>` : '<p class="empty">Nenhum custo carimbado neste mês.</p>'}

    ${renderComparison(data.comparison)}
    ${renderAgentMix(data.agent_mix)}
    ${renderModelMix(data.model_mix)}
    ${renderCacheSavings(data.cache_savings)}

    <p class="billing-note">
      Total ≡ soma dos custos carimbados dos traces do mês (uma única fonte de
      verdade). Valores exibidos arredondados half-up em 2 casas; as partes
      exibidas fecham exatamente com o total exibido. Mês fechado é servido do
      snapshot de auditoria — o número nunca muda depois do fechamento.
    </p>`;

  wirePanelClose();
};

const openBillPanel = async (year, month) => {
  const seq = openPanelShell('Detalhe da fatura', 'Fatura');
  try {
    const data = await fetchJson(
      `${API_BASE}/billing/summary?year=${Number(year)}&month=${Number(month)}`,
    );
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

const renderBillRow = (bill) => `<tr class="clickable" role="button" tabindex="0" data-year="${Number(bill.year)}" data-month="${Number(bill.month)}">
  <td class="agent-name">${escapeHtml(bill.month_label)}${bill.snapshot_version !== null && bill.snapshot_version > 1 ? ` <span class="when">snapshot v${Number(bill.snapshot_version)}</span>` : ''}</td>
  <td>${statusPillHtml(bill)}${bill.quarantined_trace_count > 0
    ? ` <span class="pending" title="traces chegados após o fechamento — fora da fatura congelada">${Number(bill.quarantined_trace_count)} em quarentena</span>`
    : ''}</td>
  <td class="num">${Number(bill.stamped_trace_count)}</td>
  <td class="num">${bill.pending_trace_count > 0
    ? `<span class="pending">${Number(bill.pending_trace_count)}</span>`
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
    const data = await fetchJson(`${API_BASE}/bills`);
    if (seq !== billsLoadSeq) return;
    billsTotalLabel.textContent = `${data.bills.length} fatura(s)`;
    billsBody.innerHTML = data.bills.length
      ? data.bills.map(renderBillRow).join('')
      : '<tr><td colspan="6" class="empty">Nenhuma fatura.</td></tr>';
  } catch (err) {
    if (seq !== billsLoadSeq) return;
    billsBody.innerHTML = '<tr><td colspan="6" class="empty">—</td></tr>';
    errorBox.textContent = err.status === 401
      ? err.message
      : `Falha ao carregar faturas: ${err.message}. A API do cliente está no ar?`;
    errorBox.classList.remove('hidden');
  }
};

onRowActivate(billsBody, 'tr[data-year]', (row) =>
  openBillPanel(row.dataset.year, row.dataset.month));

/* ---------- Projeção do mês corrente (US12) ---------- */

const projectionCard = document.getElementById('billing-projection');

const loadBillingProjection = async () => {
  try {
    const data = await fetchJson(`${API_BASE}/billing/projection`);
    projectionCard.innerHTML = `
      <div class="projection-label">Projeção de ${escapeHtml(data.month_label)} · estimativa — não é fatura</div>
      ${data.insufficient_data
        ? `<div>Dados insuficientes para projetar (${Number(data.complete_days)} dia(s) completo(s)).</div>`
        : `<span class="projection-value">${escapeHtml(data.projected_cost_brl_display)}</span>
           <span class="when">projetado · ${escapeHtml(data.accrued_cost_brl_display)} até agora</span>`}
      <div class="projection-basis">${escapeHtml(data.basis_text)}</div>`;
    projectionCard.classList.remove('hidden');
  } catch {
    /* Estimate only — absence is fine; the card just stays hidden. */
    projectionCard.classList.add('hidden');
  }
};

/* ---------- Evolução do custo (US11 + visão diária, decisão 97) ---------- */
/* Every series arrives with bar heights AND stacked segment geometry
   precomputed on ONE shared scale — toggling series or granularity is a
   pure re-bind, no client math (decision 51). */

const evolutionPanel = document.getElementById('billing-evolution');
const seriesChips = document.getElementById('billing-series-chips');
const billingChart = document.getElementById('billing-chart');
const billingChartX = document.getElementById('billing-chart-x');
const billingChartLegend = document.getElementById('billing-chart-legend');
const granMonthBtn = document.getElementById('gran-month');
const granDayBtn = document.getElementById('gran-day');
const dayRangeSeg = document.getElementById('day-range-seg');

const MAX_SERIES_CHIPS = 9;

const billingSeriesState = {
  granularity: 'month',
  days: 30,
  series: [],
  selectedKey: 'total',
};

const renderBillingChart = () => {
  const series = billingSeriesState.series.find(
    (candidate) => candidate.key === billingSeriesState.selectedKey,
  ) ?? billingSeriesState.series[0];
  if (!series) return;

  const daily = billingSeriesState.granularity === 'day';

  billingChart.innerHTML = series.points.map((point) => {
    const segments = point.segments.map((segment) =>
      `<div class="billing-seg tk-${escapeHtml(segment.token_type)}" style="height:${Number(segment.stack_percent)}%" title="${escapeHtml(point.month_label)} · ${escapeHtml(segment.label)}"></div>`,
    ).join('');
    return `
    <div class="billing-bar-col" title="${escapeHtml(point.month_label)} · ${escapeHtml(point.cost_brl_display)}${point.partial ? ' (parcial)' : ''}">
      <span class="bar-value">${escapeHtml(point.cost_brl_display)}</span>
      <div class="billing-stack${point.partial ? ' partial' : ''}" style="height:${Number(point.height_percent)}%">${segments}</div>
    </div>`;
  }).join('');

  // Daily x-axis: label every Nth day so 90 bars stay readable.
  const labelEvery = daily ? Math.ceil(series.points.length / 12) : 1;
  billingChartX.innerHTML = series.points.map((point, index) =>
    `<span>${index % labelEvery === 0 ? escapeHtml(point.short_label) : ''}${point.partial && index % labelEvery === 0 ? '*' : ''}</span>`,
  ).join('');

  billingChartLegend.innerHTML = Object.entries(TOKEN_TYPE_LABELS).map(([type, label]) =>
    `<span><span class="tk-swatch" style="background:${TOKEN_TYPE_COLORS[type]}"></span>${label}</span>`,
  ).join('');
};

const renderSeriesChips = () => {
  // Agent/model toggles exist on the monthly lens; the daily lens is the
  // total only (decision 97).
  if (billingSeriesState.granularity === 'day') {
    seriesChips.innerHTML = '';
    return;
  }
  const chips = billingSeriesState.series
    .filter((series) => series.kind !== 'model')
    .slice(0, MAX_SERIES_CHIPS);
  seriesChips.innerHTML = chips.map((series) =>
    `<button class="series-chip${series.key === billingSeriesState.selectedKey ? ' active' : ''}" data-series-key="${escapeHtml(series.key)}">${escapeHtml(series.label)}</button>`,
  ).join('');
};

seriesChips.addEventListener('click', (event) => {
  const chip = event.target.closest('button[data-series-key]');
  if (!chip) return;
  billingSeriesState.selectedKey = chip.dataset.seriesKey;
  renderSeriesChips();
  renderBillingChart();
});

const setGranularity = (granularity) => {
  billingSeriesState.granularity = granularity;
  billingSeriesState.selectedKey = 'total';
  granMonthBtn.classList.toggle('active', granularity === 'month');
  granDayBtn.classList.toggle('active', granularity === 'day');
  dayRangeSeg.classList.toggle('hidden', granularity !== 'day');
  loadBillingSeries();
};

granMonthBtn.addEventListener('click', () => setGranularity('month'));
granDayBtn.addEventListener('click', () => setGranularity('day'));

dayRangeSeg.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-days]');
  if (!btn) return;
  billingSeriesState.days = Number(btn.dataset.days);
  dayRangeSeg.querySelectorAll('.seg-btn').forEach((candidate) =>
    candidate.classList.toggle('active', candidate === btn));
  loadBillingSeries();
});

let billingSeriesSeq = 0;

const loadBillingSeries = async (initial = false) => {
  const seq = ++billingSeriesSeq;
  try {
    const params = billingSeriesState.granularity === 'day'
      ? `granularity=day&days=${billingSeriesState.days}`
      : 'granularity=month&months=12';
    const data = await fetchJson(`${API_BASE}/billing/series?${params}`);
    if (seq !== billingSeriesSeq) return;
    if (initial && data.granularity === 'month' && data.months.length < 2) {
      // A one-month monthly chart says nothing yet (history "nasce raso e
      // engorda", T8) — fall back to the DAILY lens instead of hiding the
      // panel: hiding it would also hide the granularity toggle, making
      // the daily view unreachable. An explicit "Meses" click still
      // renders whatever exists.
      setGranularity('day');
      return;
    }
    billingSeriesState.series = data.series;
    if (!data.series.some((series) => series.key === billingSeriesState.selectedKey)) {
      billingSeriesState.selectedKey = 'total';
    }
    renderSeriesChips();
    renderBillingChart();
    evolutionPanel.classList.remove('hidden');
  } catch {
    if (seq !== billingSeriesSeq) return;
    evolutionPanel.classList.add('hidden');
  }
};

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
    loadOnce: () => {
      loadBills();
      loadBillingSeries(true);
      loadBillingProjection();
    },
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
