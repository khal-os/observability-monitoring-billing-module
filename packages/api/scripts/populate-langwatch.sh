#!/usr/bin/env bash
#
# Populate the LangWatch instance with realistic demo traffic so the sync
# (npm run sync) has real data to ingest. Sends traces via the collector
# API (POST /api/collector) with varied sessions, span counts, token
# volumes and durations:
#
#   - sess-agenda-*   whatsapp · saude/atendimento · claude-sonnet-5
#                     4-turn conversation over ~25 min, one turn with a
#                     tool error, one turn using cache_read tokens
#   - sess-checkout-* web · varejo/checkout · openai/gpt-5-mini
#                     2 short turns
#   - sess-suporte-*  whatsapp · telecom/suporte · gpt-4o-mini
#                     3 turns, one heavy (~12k tokens, ~20 s, 5 spans)
#   - 1 standalone trace (no thread_id) · web onboarding
#   - 1 trace on an UNPRICED model (openai/gpt-5-nano) -> pending_price
#
# Usage:
#   ./scripts/populate-langwatch.sh
#   npm run sync -- --from <today> --to <tomorrow>
#
# Reads LANGWATCH_ENDPOINT / LANGWATCH_API_KEY from ../.env.development
# unless already exported.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${LANGWATCH_ENDPOINT:-}" || -z "${LANGWATCH_API_KEY:-}" ]]; then
  LANGWATCH_ENDPOINT=$(grep -oP '(?<=^LANGWATCH_ENDPOINT=").*(?="$)' .env.development)
  LANGWATCH_API_KEY=$(grep -oP '(?<=^LANGWATCH_API_KEY=").*(?="$)' .env.development)
fi

NOW=$(date +%s%3N)          # epoch ms
RUN=$(date +%H%M%S)         # unique-ish suffix per run

send() { # $1 = label; JSON body on stdin
  local status
  status=$(curl -sS -o /tmp/langwatch-populate-last.json -w '%{http_code}' \
    -X POST "${LANGWATCH_ENDPOINT}/api/collector" \
    -H "X-Auth-Token: ${LANGWATCH_API_KEY}" \
    -H 'Content-Type: application/json' \
    --data-binary @-)
  if [[ "$status" == 2* ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1 (HTTP $status): $(cat /tmp/langwatch-populate-last.json)" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Sessão 1 — agendamento de consultas (whatsapp, claude-sonnet-5)
# ---------------------------------------------------------------------------
S1="sess-agenda-${RUN}"
S1_META='"thread_id": "'"$S1"'", "user_id": "user-ana-souza",
         "agent": "agente-agendamento", "agent.version": "2.3.1",
         "agent.instance": "agendamento-prod-1",
         "channel": "whatsapp", "channel.version": "1.4.0",
         "channel.instance": "omni-wa-prod-2",
         "domain": "saude", "subdomain": "atendimento"'

# Turno 1 — saudação curta (2 spans, ~1.2 s, poucos tokens) — há ~25 min
T=$((NOW - 25*60*1000))
send "S1/t1 saudacao" <<EOF
{
  "trace_id": "tr-agenda-${RUN}-01",
  "metadata": { ${S1_META} },
  "spans": [
    {
      "type": "agent", "span_id": "sp-${RUN}-0101",
      "input":  { "type": "text", "value": "Oi! Queria marcar uma consulta com cardiologista." },
      "output": { "type": "text", "value": "Olá, Ana! Claro. Você prefere atendimento presencial ou por telemedicina?" },
      "timestamps": { "started_at": ${T}, "finished_at": $((T + 1200)) }
    },
    {
      "type": "llm", "span_id": "sp-${RUN}-0102", "parent_id": "sp-${RUN}-0101",
      "model": "anthropic/claude-sonnet-5",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Oi! Queria marcar uma consulta com cardiologista." }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Olá, Ana! Claro. Você prefere atendimento presencial ou por telemedicina?" }] },
      "metrics": { "prompt_tokens": 210, "completion_tokens": 28 },
      "timestamps": { "started_at": $((T + 150)), "finished_at": $((T + 1100)) }
    }
  ]
}
EOF

# Turno 2 — busca de horários (rag + llm + tool, ~4.5 s) — há ~23 min
T=$((NOW - 23*60*1000))
send "S1/t2 busca-horarios" <<EOF
{
  "trace_id": "tr-agenda-${RUN}-02",
  "metadata": { ${S1_META} },
  "spans": [
    {
      "type": "agent", "span_id": "sp-${RUN}-0201",
      "input":  { "type": "text", "value": "Presencial, na unidade Aldeota. Pode ser semana que vem de manhã." },
      "output": { "type": "text", "value": "Encontrei estes horários com a Dra. Mendes na Aldeota: terça 09h, quarta 08h30 ou quinta 10h. Qual prefere?" },
      "timestamps": { "started_at": ${T}, "finished_at": $((T + 4500)) }
    },
    {
      "type": "rag", "span_id": "sp-${RUN}-0202", "parent_id": "sp-${RUN}-0201",
      "name": "kb.convenios-unidades",
      "input":  { "type": "text", "value": "unidade Aldeota cardiologia convênios atendidos" },
      "output": { "type": "text", "value": "[2 documentos: unidades-fortaleza.md, especialidades-cardiologia.md]" },
      "timestamps": { "started_at": $((T + 100)), "finished_at": $((T + 900)) }
    },
    {
      "type": "tool", "span_id": "sp-${RUN}-0203", "parent_id": "sp-${RUN}-0201",
      "name": "agenda.buscar-horarios",
      "input":  { "type": "json", "value": { "especialidade": "cardiologia", "unidade": "aldeota", "periodo": "manha" } },
      "output": { "type": "json", "value": { "horarios": ["2026-07-28T09:00", "2026-07-29T08:30", "2026-07-30T10:00"], "medico": "Dra. Mendes" } },
      "timestamps": { "started_at": $((T + 1000)), "finished_at": $((T + 2600)) }
    },
    {
      "type": "llm", "span_id": "sp-${RUN}-0204", "parent_id": "sp-${RUN}-0201",
      "model": "anthropic/claude-sonnet-5",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Monte a resposta com os horários disponíveis: ter 09h, qua 08h30, qui 10h (Dra. Mendes, Aldeota)." }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Encontrei estes horários com a Dra. Mendes na Aldeota: terça 09h, quarta 08h30 ou quinta 10h. Qual prefere?" }] },
      "metrics": { "prompt_tokens": 980, "completion_tokens": 52 },
      "timestamps": { "started_at": $((T + 2700)), "finished_at": $((T + 4400)) }
    }
  ]
}
EOF

# Turno 3 — confirmação FALHA no gateway de agenda (tool error) — há ~20 min
T=$((NOW - 20*60*1000))
send "S1/t3 confirma-erro" <<EOF
{
  "trace_id": "tr-agenda-${RUN}-03",
  "metadata": { ${S1_META} },
  "spans": [
    {
      "type": "agent", "span_id": "sp-${RUN}-0301",
      "input":  { "type": "text", "value": "Quinta às 10h, por favor." },
      "output": { "type": "text", "value": "Tive um problema para confirmar agora. Pode aguardar um instante que tento de novo?" },
      "error": { "has_error": true, "message": "agenda.confirmar: upstream timeout after 3000ms", "stacktrace": [] },
      "timestamps": { "started_at": ${T}, "finished_at": $((T + 5200)) }
    },
    {
      "type": "llm", "span_id": "sp-${RUN}-0302", "parent_id": "sp-${RUN}-0301",
      "model": "anthropic/claude-sonnet-5",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Quinta às 10h, por favor." }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Ação: confirmar horário 2026-07-30T10:00 com agenda.confirmar." }] },
      "metrics": { "prompt_tokens": 1150, "completion_tokens": 34 },
      "timestamps": { "started_at": $((T + 120)), "finished_at": $((T + 1500)) }
    },
    {
      "type": "tool", "span_id": "sp-${RUN}-0303", "parent_id": "sp-${RUN}-0301",
      "name": "agenda.confirmar",
      "input":  { "type": "json", "value": { "horario": "2026-07-30T10:00", "medico": "Dra. Mendes", "paciente": "user-ana-souza" } },
      "output": { "type": "text", "value": "" },
      "error": { "has_error": true, "message": "agenda.confirmar: upstream timeout after 3000ms", "stacktrace": [] },
      "timestamps": { "started_at": $((T + 1600)), "finished_at": $((T + 4700)) }
    }
  ]
}
EOF

# Turno 4 — retry com sucesso, prompt reaproveitado do cache — há ~18 min
T=$((NOW - 18*60*1000))
send "S1/t4 confirma-ok" <<EOF
{
  "trace_id": "tr-agenda-${RUN}-04",
  "metadata": { ${S1_META} },
  "spans": [
    {
      "type": "agent", "span_id": "sp-${RUN}-0401",
      "input":  { "type": "text", "value": "Claro, aguardo." },
      "output": { "type": "text", "value": "Consulta confirmada! Quinta 30/07 às 10h com a Dra. Mendes, unidade Aldeota. Enviei o comprovante por SMS." },
      "timestamps": { "started_at": ${T}, "finished_at": $((T + 3800)) }
    },
    {
      "type": "tool", "span_id": "sp-${RUN}-0402", "parent_id": "sp-${RUN}-0401",
      "name": "agenda.confirmar",
      "input":  { "type": "json", "value": { "horario": "2026-07-30T10:00", "medico": "Dra. Mendes", "paciente": "user-ana-souza", "retry": 1 } },
      "output": { "type": "json", "value": { "status": "confirmado", "protocolo": "AGD-88412" } },
      "timestamps": { "started_at": $((T + 100)), "finished_at": $((T + 1900)) }
    },
    {
      "type": "llm", "span_id": "sp-${RUN}-0403", "parent_id": "sp-${RUN}-0401",
      "model": "anthropic/claude-sonnet-5",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Redija a confirmação: protocolo AGD-88412, quinta 30/07 10h, Dra. Mendes, Aldeota." }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Consulta confirmada! Quinta 30/07 às 10h com a Dra. Mendes, unidade Aldeota. Enviei o comprovante por SMS." }] },
      "metrics": { "prompt_tokens": 240, "completion_tokens": 46, "cache_read_input_tokens": 1050 },
      "timestamps": { "started_at": $((T + 2000)), "finished_at": $((T + 3700)) }
    }
  ]
}
EOF

# ---------------------------------------------------------------------------
# Sessão 2 — checkout no site (web, openai/gpt-5-mini)
# ---------------------------------------------------------------------------
S2="sess-checkout-${RUN}"
S2_META='"thread_id": "'"$S2"'", "user_id": "user-bruno-lima",
         "agent": "agente-vendas", "agent.version": "1.8.0",
         "agent.instance": "vendas-prod-3",
         "channel": "web", "channel.version": "3.2.1",
         "channel.instance": "widget-site-1",
         "domain": "varejo", "subdomain": "checkout"'

# Turno 1 — dúvida de produto (rag + llm, ~2.8 s) — há ~55 min
T=$((NOW - 55*60*1000))
send "S2/t1 duvida-produto" <<EOF
{
  "trace_id": "tr-checkout-${RUN}-01",
  "metadata": { ${S2_META} },
  "spans": [
    {
      "type": "rag", "span_id": "sp-${RUN}-1101",
      "name": "kb.catalogo",
      "input":  { "type": "text", "value": "tenis corrida amortecimento garantia troca" },
      "output": { "type": "text", "value": "[3 documentos: produto-tenis-x9.md, politica-trocas.md, tabela-medidas.md]" },
      "timestamps": { "started_at": $((T + 80)), "finished_at": $((T + 700)) }
    },
    {
      "type": "llm", "span_id": "sp-${RUN}-1102",
      "model": "openai/gpt-5-mini",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Esse tênis X9 serve para corrida de rua? E se não servir, consigo trocar?" }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Sim! O X9 é voltado para corrida de rua, com amortecimento em gel. E você tem 30 dias para troca gratuita pelo site." }] },
      "metrics": { "prompt_tokens": 620, "completion_tokens": 58 },
      "timestamps": { "started_at": $((T + 800)), "finished_at": $((T + 2700)) }
    }
  ]
}
EOF

# Turno 2 — aplicar cupom (llm + tool + llm, ~3.6 s) — há ~52 min
T=$((NOW - 52*60*1000))
send "S2/t2 cupom" <<EOF
{
  "trace_id": "tr-checkout-${RUN}-02",
  "metadata": { ${S2_META} },
  "spans": [
    {
      "type": "llm", "span_id": "sp-${RUN}-1201",
      "model": "openai/gpt-5-mini",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Tenho o cupom BEMVINDO10, aplica pra mim?" }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Ação: validar e aplicar cupom BEMVINDO10 no carrinho atual." }] },
      "metrics": { "prompt_tokens": 480, "completion_tokens": 22 },
      "timestamps": { "started_at": ${T}, "finished_at": $((T + 1100)) }
    },
    {
      "type": "tool", "span_id": "sp-${RUN}-1202",
      "name": "carrinho.aplicar-cupom",
      "input":  { "type": "json", "value": { "cupom": "BEMVINDO10", "carrinho": "cart-77121" } },
      "output": { "type": "json", "value": { "status": "aplicado", "desconto_percent": 10, "novo_total_brl": "269.91" } },
      "timestamps": { "started_at": $((T + 1200)), "finished_at": $((T + 2100)) }
    },
    {
      "type": "llm", "span_id": "sp-${RUN}-1203",
      "model": "openai/gpt-5-mini",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Confirme a aplicação: 10% off, novo total R$ 269,91." }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Cupom aplicado! Seu carrinho ficou em R$ 269,91 com 10% de desconto. Quer finalizar a compra?" }] },
      "metrics": { "prompt_tokens": 310, "completion_tokens": 38 },
      "timestamps": { "started_at": $((T + 2200)), "finished_at": $((T + 3500)) }
    }
  ]
}
EOF

# ---------------------------------------------------------------------------
# Sessão 3 — suporte técnico longo (whatsapp, gpt-4o-mini)
# ---------------------------------------------------------------------------
S3="sess-suporte-${RUN}"
S3_META='"thread_id": "'"$S3"'", "user_id": "user-carla-dias",
         "agent": "agente-suporte", "agent.version": "4.0.2",
         "agent.instance": "suporte-prod-1",
         "channel": "whatsapp", "channel.version": "1.4.0",
         "channel.instance": "omni-wa-prod-1",
         "domain": "telecom", "subdomain": "suporte"'

# Turno 1 — problema relatado (~2 s) — há ~1h50
T=$((NOW - 110*60*1000))
send "S3/t1 problema" <<EOF
{
  "trace_id": "tr-suporte-${RUN}-01",
  "metadata": { ${S3_META} },
  "spans": [
    {
      "type": "llm", "span_id": "sp-${RUN}-2101",
      "model": "gpt-4o-mini",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Minha internet está caindo toda hora desde ontem à noite." }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Sinto muito, Carla! Vou verificar sua conexão. Pode me confirmar se a luz 'LOS' do modem está vermelha?" }] },
      "metrics": { "prompt_tokens": 380, "completion_tokens": 42 },
      "timestamps": { "started_at": ${T}, "finished_at": $((T + 2000)) }
    }
  ]
}
EOF

# Turno 2 — diagnóstico pesado (5 spans, ~20 s, ~12k tokens c/ histórico) — há ~1h45
T=$((NOW - 105*60*1000))
send "S3/t2 diagnostico-pesado" <<EOF
{
  "trace_id": "tr-suporte-${RUN}-02",
  "metadata": { ${S3_META} },
  "spans": [
    {
      "type": "agent", "span_id": "sp-${RUN}-2201",
      "input":  { "type": "text", "value": "Está verde, mas a de internet pisca. Já reiniciei duas vezes." },
      "output": { "type": "text", "value": "Rodei um diagnóstico completo: há instabilidade no seu ponto desde 22h de ontem. Abri o chamado TEC-55901 com prioridade alta; um técnico vai até aí amanhã entre 8h e 12h." },
      "timestamps": { "started_at": ${T}, "finished_at": $((T + 19800)) }
    },
    {
      "type": "tool", "span_id": "sp-${RUN}-2202", "parent_id": "sp-${RUN}-2201",
      "name": "rede.diagnostico-remoto",
      "input":  { "type": "json", "value": { "cliente": "user-carla-dias", "teste": "full" } },
      "output": { "type": "json", "value": { "sinal_dbm": -27.4, "quedas_24h": 14, "inicio_instabilidade": "2026-07-19T22:04" } },
      "timestamps": { "started_at": $((T + 200)), "finished_at": $((T + 9200)) }
    },
    {
      "type": "rag", "span_id": "sp-${RUN}-2203", "parent_id": "sp-${RUN}-2201",
      "name": "kb.procedimentos",
      "input":  { "type": "text", "value": "quedas intermitentes fibra sinal -27dbm procedimento" },
      "output": { "type": "text", "value": "[4 documentos: runbook-instabilidade.md, sla-visitas.md, matriz-prioridade.md, script-cliente.md]" },
      "timestamps": { "started_at": $((T + 9300)), "finished_at": $((T + 10400)) }
    },
    {
      "type": "llm", "span_id": "sp-${RUN}-2204", "parent_id": "sp-${RUN}-2201",
      "model": "gpt-4o-mini",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "[histórico completo da conversa + resultado do diagnóstico + 4 documentos do runbook] Decida a ação." }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Instabilidade confirmada no ponto. Ação: abrir chamado técnico prioridade alta com visita." }] },
      "metrics": { "prompt_tokens": 9800, "completion_tokens": 120 },
      "timestamps": { "started_at": $((T + 10500)), "finished_at": $((T + 15600)) }
    },
    {
      "type": "tool", "span_id": "sp-${RUN}-2205", "parent_id": "sp-${RUN}-2201",
      "name": "chamados.abrir",
      "input":  { "type": "json", "value": { "tipo": "visita-tecnica", "prioridade": "alta", "cliente": "user-carla-dias" } },
      "output": { "type": "json", "value": { "chamado": "TEC-55901", "janela": "2026-07-21T08:00/12:00" } },
      "timestamps": { "started_at": $((T + 15700)), "finished_at": $((T + 17100)) }
    },
    {
      "type": "llm", "span_id": "sp-${RUN}-2206", "parent_id": "sp-${RUN}-2201",
      "model": "gpt-4o-mini",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Comunique: chamado TEC-55901, prioridade alta, visita amanhã 8h-12h, instabilidade desde 22h." }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Rodei um diagnóstico completo: há instabilidade no seu ponto desde 22h de ontem. Abri o chamado TEC-55901 com prioridade alta; um técnico vai até aí amanhã entre 8h e 12h." }] },
      "metrics": { "prompt_tokens": 1900, "completion_tokens": 64 },
      "timestamps": { "started_at": $((T + 17200)), "finished_at": $((T + 19700)) }
    }
  ]
}
EOF

# Turno 3 — encerramento (~1.4 s) — há ~1h42
T=$((NOW - 102*60*1000))
send "S3/t3 encerramento" <<EOF
{
  "trace_id": "tr-suporte-${RUN}-03",
  "metadata": { ${S3_META} },
  "spans": [
    {
      "type": "llm", "span_id": "sp-${RUN}-2301",
      "model": "gpt-4o-mini",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Perfeito, obrigada!" }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Por nada! Qualquer coisa antes da visita, é só chamar. Melhoras para a sua conexão! 😉" }] },
      "metrics": { "prompt_tokens": 260, "completion_tokens": 30 },
      "timestamps": { "started_at": ${T}, "finished_at": $((T + 1400)) }
    }
  ]
}
EOF

# ---------------------------------------------------------------------------
# Trace avulso — sem thread_id (não vira sessão)
# ---------------------------------------------------------------------------
T=$((NOW - 8*60*1000))
send "avulso onboarding" <<EOF
{
  "trace_id": "tr-onboarding-${RUN}-01",
  "metadata": {
    "user_id": "user-visitante-3391",
    "agent": "agente-onboarding", "agent.version": "0.9.0",
    "agent.instance": "onboarding-prod-1",
    "channel": "web", "channel.version": "3.2.1", "channel.instance": "widget-site-1",
    "domain": "varejo", "subdomain": "onboarding"
  },
  "spans": [
    {
      "type": "llm", "span_id": "sp-${RUN}-3101",
      "model": "openai/gpt-5-mini",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Como funciona o frete grátis?" }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Compras acima de R$ 199 têm frete grátis para todo o Nordeste; para as demais regiões, acima de R$ 299." }] },
      "metrics": { "prompt_tokens": 190, "completion_tokens": 36 },
      "timestamps": { "started_at": ${T}, "finished_at": $((T + 900)) }
    }
  ]
}
EOF

# ---------------------------------------------------------------------------
# Trace com modelo SEM preço cadastrado -> deve ficar pending_price
# ---------------------------------------------------------------------------
T=$((NOW - 5*60*1000))
send "pending-price gpt-5-nano" <<EOF
{
  "trace_id": "tr-piloto-${RUN}-01",
  "metadata": {
    "thread_id": "sess-piloto-${RUN}", "user_id": "user-piloto-7",
    "agent": "agente-triagem-piloto", "agent.version": "0.1.0",
    "agent.instance": "triagem-canary-1",
    "channel": "web", "channel.version": "3.2.1", "channel.instance": "widget-site-1",
    "domain": "varejo", "subdomain": "triagem"
  },
  "spans": [
    {
      "type": "llm", "span_id": "sp-${RUN}-4101",
      "model": "openai/gpt-5-nano",
      "input":  { "type": "chat_messages", "value": [{ "role": "user", "content": "Quero falar sobre um pedido que não chegou." }] },
      "output": { "type": "chat_messages", "value": [{ "role": "assistant", "content": "Encaminhando você para o time de pós-venda. Um instante!" }] },
      "metrics": { "prompt_tokens": 150, "completion_tokens": 18 },
      "timestamps": { "started_at": ${T}, "finished_at": $((T + 700)) }
    }
  ]
}
EOF

echo
echo "Pronto: 11 traces enviados (3 sessões + 1 avulso + 1 pending_price)."
echo "Agora rode o sync (janela de hoje):"
echo "  npm run sync -- --from $(date +%F) --to $(date -d tomorrow +%F)"
