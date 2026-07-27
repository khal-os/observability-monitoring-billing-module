# Plataforma de Agentes de IA — Backlog Consolidado v2.3
### Uma API, três abas: **Billing · Traces · Sessions**
Discovery: jul/2026 · v2.3 — versão de trabalho alinhada à planilha Traces_Sessions_Billing-v2.3: carimbo de preço na ingestão; cortes US9/US13/US14/US16; Reconciliação dobrada em T6/T7/US7

---

## 0. A moldura do produto

**Visão.** Uma plataforma single-tenant (uma instância por cliente) onde o cliente enxerga, valida e entende seus agentes de IA. A lógica das três abas conta uma história só: **Billing** diz quanto custou, **Traces** mostra as execuções reais que geraram esse custo, e **Sessions** mostra as conversas às quais essas execuções pertencem. Uma API, um armazenamento, uma verdade — tudo alimentado pelo LangWatch, que é o conector entre os agentes e a plataforma.

**Persona principal.** O gestor do lado do cliente. Os objetivos dele, em ordem de prioridade: (1) validar a fatura, (2) controlar e projetar o gasto, (3) entender o que compõe o custo, (4) prestar contas internamente. Nas abas de Traces e Sessions, o trabalho principal é **transparência e confiança**: ver as execuções e conversas por trás dos números. Depuração e revisão de qualidade são beneficiários secundários, não o motivo da aba existir.

**Persona de apoio.** O admin da plataforma (lado Khal): mantém os preços (direto no banco, na v1), acompanha a saúde da ingestão, fecha os meses e gera a fatura real a partir do extrato congelado.

**A arquitetura em uma linha.** API do LangWatch → sync em nível de trace → **precificação no ato da gravação** (cada trace entra carimbado com o preço contratado em R$ vigente na sua data; o carimbo é imutável) → armazenamento próprio (traces + spans + conteúdo completo; é o arquivo permanente, já que o LangWatch guarda só ~49 dias) → snapshots mensais (billing) + visões ao vivo (traces/sessions) → três abas de UI.

**Escopo da v1.** Só custo de tokens · agentes de texto apenas · conteúdo das conversas exibido na íntegra, sem mascaramento · single-tenant · domínio e subdomínio como strings simples · preços em R$ como dados versionados (markup, US$ e PTAX são internos e nunca chegam ao cliente) · faturamento por mês-calendário · meses fechados congelados em snapshots completos de auditoria.

**Fora da v1.** Custo de infra/compute · papéis e hierarquia de RBAC · canal de voz · política de mascaramento e retenção (a postura da v1 é explícita: guarda tudo, para sempre) · telas de admin para preço/reclassificação/reabertura (o motor existe, a operação é via runbook) · alertas e notificações · fluxo de contestação.

**Princípio do backlog.** Quando adiamos uma história de usuário, estamos adiando só a camada de interação. As tech stories que a sustentam — o motor — são construídas na v1. Assim, a tela futura vira só uma janela para um comportamento que já funciona.

**Ordem de construção.** A ordem dos épicos segue a cadeia de derivação dos dados — o trace é o átomo; sessão é trace agrupado; billing é trace precificado e congelado: Épico 1 (Fundação: sync e armazenamento de traces) → 2 (Preços e custo por trace) → 3 (Aba Traces) → 4 (Aba Sessions) → 5 (Fechamento do mês) → 6 (Validação da fatura) → 7 (Tendências) → 8 (Composição) → 9 (Exportação) → 10 (Reconciliação, cujo check de mês aberto pode ligar assim que o billing ao vivo existir). Trade-off consciente e registrado (decisão 24): a validação da fatura — objetivo nº 1 do gestor — chega depois das abas Traces/Sessions; em compensação, nenhum mês fecha antes de estar integralmente ingerido, e a transparência das execuções entrega valor desde cedo. **Os IDs de histórias (T1–T12, US1–US25) permanecem os mesmos da v2** — só a ordem e a numeração dos épicos mudaram.

---

## Épico 1 — Preços e Contratos

**Objetivo.** Os preços contratados do cliente, em R$ (por modelo × tipo de token), guardados como dados versionados — mantidos direto no banco na v1. Este épico vem **antes de tudo** por uma razão de arquitetura: a ingestão **carimba o preço no trace no ato da gravação**; sem tabela de preços de pé, o pipeline não roda. O cliente nunca vê markup, US$ nem PTAX.

### T4 — Modelo de dados de preços versionado (mantido via banco na v1)
- Registro de preço = modelo + tipo de token + valor em R$ por milhão de tokens + vigência-de (a vigência-até deriva da versão seguinte). Single-tenant: uma instância por cliente, então não precisa de chave de cliente — mas vale manter o schema honesto se o código for compartilhado entre instâncias.
- Lookup **as-of** determinístico para qualquer data de uso.
- Versões imutáveis: mudança é insert novo, nunca update em cima.
- Constraints do banco barram duplicidade (modelo, tipo de token, vigência-de) e vigências dentro de mês fechado.
- A lista de modelos é dado, não código — modelo novo entra sem deploy.
- Colunas internas opcionais por versão (custo de mercado em US$, PTAX de referência, markup %) — não entram no cálculo da v1, invisíveis ao cliente, mas capturadas desde já para a futura análise de margem.
- Runbook: o procedimento/SQL canônico para mexer em preço.
*Habilita: a precificação no ato da ingestão (T5, Épico 2), US3, US4 e todos os épicos seguintes; futuras telas de preço e histórico.*

### US3 — Alerta de uso sem preço (admin, mínimo)
*Como admin da plataforma, quero ser avisado quando entrar uso sem preço aplicável (modelo desconhecido ou versão faltando), para que nenhum consumo seja cobrado a zero em silêncio, nem se perca.*
- Traces ingeridos sem preço aplicável ficam como 'preço pendente' (com volume, período e modelo identificáveis); o aviso aparece onde o admin já olha — sem tela dedicada.
- Nunca aparece como R$ 0,00 para o cliente; ou se resolve — registra-se o preço e os traces pendentes são carimbados (só em mês aberto) — ou se exclui explicitamente antes do fechamento.

### US4 — Gestor vê os preços contratados
*Como gestor do cliente, quero ver a tabela de preços aplicada à minha empresa (R$ por milhão de tokens, por modelo e tipo de token), para conferir a conta da fatura contra o meu contrato.*
- Somente leitura; a versão aplicada ao período em tela (quando o fechamento de mês existir — Épico 5 —, mês fechado renderiza a partir do snapshot; até lá e no mês corrente, mostra a versão vigente).
- Só os preços finais em R$ — nada de US$, PTAX, markup ou campo interno, em lugar nenhum.

**Adiado:** tela de cadastro/alteração de preços · visão de histórico · análise de margem · construções contratuais (mínimos, faixas de volume, taxas fixas).

---

## Épico 2 — Fundação: contrato de metadados, ingestão com precificação no ato, e armazenamento

**Objetivo.** Traces completos (métricas, spans e o conteúdo integral das conversas) fluem do LangWatch para o armazenamento próprio dentro da janela de 49 dias — e **já entram precificados**: no ato da gravação, cada trace recebe o carimbo do preço vigente e do custo resultante, que se torna imutável dali em diante. Os agregados do billing são somas desses custos carimbados — o insumo do faturamento, por construção.

### T1 — Contrato de metadados (um contrato, três consumidores)
Definir e documentar o contrato de metadados dos traces do LangWatch, atendendo billing, traces e sessions de uma vez.
- Campos do trace: ID do trace, **ID da sessão**, ID do agente, modelo(s), timestamps de início/fim, status (ok/erro), contagem de tokens por tipo (input / output / cache leitura / cache escrita), **canal** (whatsapp/web/… — deixa o terreno pronto para voz), **domínio e subdomínio como strings opcionais**, tipo do trace.
- Campos do span: ID, trace pai, tipo (llm, tool, retrieval, guardrail, …), nome (ex.: nome da ferramenta — nomes crus servem na v1), início/fim, status, mensagem de erro quando falha, tokens quando aplicável.
- Conteúdo: payloads completos de entrada e saída por trace e pelos spans relevantes (sem mascaramento — decisão da v1).
- **Matriz campo × consumidor** (billing / traces / sessions): quem precisa de quê; obrigatório vs. opcional, com comportamento de fallback. A atribuição de segmento do billing (system prompt / tool call / conversa) se deriva dos spans — uma instrumentação serve às duas visões.
- Versionado; acordado com os times dos agentes. **É a dependência que trava a fase de modelagem.**
*Habilita: tudo.*

### T2 — Sync em nível de trace, com detecção de buracos e proteção da janela de retenção
Job agendado que ingere traces completos (conforme T1) da API do LangWatch.
- Agendado, incremental, **idempotente** (reexecuções e janelas sobrepostas nunca contam em dobro), seguro contra falhas (escrita parcial nunca conta como completa), toda execução logada (janela, registros, status).
- Ingere o trace inteiro: métricas, spans, conteúdo — e aciona a precificação no ato (T5): o trace já é gravado com o custo carimbado (ou como preço pendente).
- **Proteção da janela de retenção:** alertas escalam conforme dados não sincronizados envelhecem rumo ao limite de 49 dias do LangWatch; o monitoramento expõe o timestamp mais antigo ainda não sincronizado. Uma pane no sync tem prazo fatal — isso aqui é prevenção de perda de dados, não higiene.
- **Detecção de buracos:** continuidade verificável; lacunas detectadas e reportadas; uma rodada de reparo rebusca qualquer janela que ainda esteja dentro da retenção.
- **Backfill de largada:** a primeira execução ingere tudo que o LangWatch ainda guarda (~49 dias) — esse é o histórico inaugural da plataforma. Rodar o quanto antes: cada semana de atraso é história perdida para sempre.
*Habilita: US1, US2, todas as abas. (Depende também do T4 — sem tabela de preços não há carimbo.)*

### T3 — Armazenamento de traces e agregados derivados
Modelo de armazenamento: traces, spans e conteúdo no banco próprio; agregados do billing derivados dali.
- Entidades: trace (todos os campos do T1) → spans ordenados e cronometrados → blocos de conteúdo; índices pensados para as consultas das abas (período + agente + status + domínio/subdomínio + tipo + busca por ID).
- **Os agregados diários do billing (agente × modelo × tipo de token × segmento × dia) são somas dos custos carimbados nos traces armazenados** — uma fonte só, uma precificação só.
- Sessão é um read-model derivado: agrupamento dos traces por ID de sessão (materializado ou calculado — decisão de implementação).
- Traces com metadados ausentes ou inválidos são armazenados e marcados como "não classificados", com o motivo — nunca descartados (sem tela na v1).
- Correções de atribuição/metadados continuam possíveis em períodos abertos, com reagregação em cascata — o carimbo de preço não muda (T5); a tela fica para depois.
- O armazenamento é o arquivo permanente: nada de expurgo automático na v1; política de retenção é uma decisão adiada e registrada.
*Habilita: US1, US2, todos os épicos seguintes e a futura tela de reclassificação.*

### T5 — Precificação no ato da ingestão (price stamping)
No momento em que o trace é gravado, o pipeline resolve o preço e **carimba** o custo no registro. O carimbo é definitivo.
- Regra do carimbo: usa-se a versão de preço **vigente na data do trace**, resolvida no ato da ingestão (as-of na escrita — confirmar na QA19). Carimbam-se, por tipo de token: preço aplicado (R$/milhão) e custo resultante; o custo total do trace é a soma.
- **Imutável depois de gravado:** mudança de preço posterior vale só para traces ingeridos dali em diante — nunca reprecifica trace consolidado. A imutabilidade sai do fechamento do mês e passa para a escrita.
- Trace ingerido sem preço aplicável entra como **'preço pendente'** (tokens guardados, custo em aberto, fora dos totais em R$ — nunca valorado a zero); ao registrar o preço (só em mês aberto), os pendentes são carimbados. A US3 vigia essa fila.
- Carimbo errado só se corrige pelo fluxo auditado de reabertura (T6) — sem recálculo silencioso.
- Determinístico e reproduzível ao centavo; regra de arredondamento definida e documentada (precisão cheia na linha; arredondar só totais exibidos/faturados, half-up 2 casas); as partes exibidas fecham com o total exibido.
- Correção de **atribuição** (agente/metadados, período aberto) segue possível e não altera o carimbo — o preço é por modelo, não por agente.
*Habilita: o custo por trace das abas Traces/Sessions e, adiante, os agregados e snapshots do billing.*

### US1 — Visibilidade da saúde do sync e do risco de perda de dados (admin)
*Como admin da plataforma, quero enxergar a saúde da ingestão — último sync bem-sucedido, dado mais antigo não sincronizado, buracos detectados — para agir antes que a janela de 49 dias transforme um atraso em perda definitiva.*
- A saúde aparece onde o admin já olha (endpoint de status / log / alerta — sem tela dedicada na v1).
- Alerta em limiar de atenção (~35 dias) e crítico (~45 dias) de idade do dado não sincronizado, e em qualquer buraco detectado.

### US2 — Visibilidade da atualização dos dados (gestor)
*Como gestor do cliente, quero saber quando os dados que estou vendo foram atualizados pela última vez, para nunca confundir dado velho ou parcial com a realidade.*
- Toda visão do gestor mostra "dados atualizados em [timestamp]", lendo do mesmo status da US1 — uma verdade só sobre atualização.
- Se o sync falhar ou atrasar, o admin é alertado; o gestor continua vendo o timestamp honesto.

**Adiado:** fluxo de revisão de agentes novos (o motor já ingere agentes desconhecidos — T3) · tela de gestão de uso não classificado (armazenado e marcado, atribuição mutável — T3) · política de retenção/mascaramento (LGPD) · voz (chega como novo canal + novos tipos de span, sem migração).

---

## Épico 3 — Aba Traces

**Objetivo.** O gestor vê as execuções reais por trás dos números: uma lista filtrável de traces com custo por execução, e um drawer com a anatomia completa de qualquer uma — métricas, cascata de spans e o conteúdo da conversa. Trabalho principal: transparência e confiança.

### T10 — API de consulta de traces
Endpoints que servem a aba a partir do armazenamento próprio.
- Endpoint de listagem: filtros de período (intervalo de datas), agente, status (todos/ok/erro), tipo de trace, domínio/subdomínio (match de string), busca livre por ID de trace/sessão; paginação e ordenação no servidor (mais recente primeiro, por padrão).
- Custo por trace = **o valor carimbado na ingestão** (T5) — o mesmo número que alimenta os agregados do billing, por construção.
- Endpoint de detalhe: o trace inteiro — métricas, spans ordenados com tempo/status/erro, conteúdo de entrada e saída.
- Meta de desempenho: listagem paginada e indexada para o volume realista do armazenamento (dimensionamento na QA15).
*Habilita: US18–US20 e o épico de Reconciliação.*

### US18 — Lista de traces com filtros
*Como gestor do cliente, quero navegar e filtrar as execuções dos meus agentes (por período, agente, status, tipo, domínio/subdomínio), com o custo de cada uma, para ver a atividade concreta pela qual estou pagando.*
- Colunas (o mock é a referência): ID do trace (mono), agente (+ caminho domínio/subdomínio quando houver), tag de tipo, pill de status, duração, tokens (in+out), **custo em R$**, quando (relativo se for hoje; dd/mm hh:mm antes disso).
- Filtros combináveis; estados vazios honestos ("nenhum trace neste período/filtro").
- Honestidade sobre frescor desde já: o dado é tão fresco quanto o último sync (timestamp da US2 à vista); quando o ciclo de fechamento existir (Épico 5), a US6 soma o rótulo fechado/em andamento.

### US19 — Drawer do trace: a anatomia de uma execução
*Como gestor do cliente, quero abrir qualquer trace e ver sua anatomia completa — métricas, a cascata passo a passo e o conteúdo real da conversa — para entender exatamente o que é uma execução e quanto ela custou.*
- Cabeçalho: agente + caminho, chip de canal, timestamp completo + relativo, modelo servido, **link para a sessão dele**.
- Linha de métricas: duração, tokens in, tokens out, custo (R$).
- **Cascata de spans:** barras posicionadas no tempo, cor por tipo de span, span que falhou em destaque; nomes visíveis (crus mesmo); expandir/passar o mouse mostra tempo e status do span.
- **Conteúdo:** a entrada e a saída do trace na íntegra (sem mascaramento — decisão da v1); em erro, a mensagem do span que falhou.
- Tudo vem do armazenamento próprio (autocontido — sem dependência do LangWatch na hora de exibir).

### US20 — Deeplink trace → sessão
*Como gestor do cliente, quero pular de um trace para a sessão (conversa) a que ele pertence, para ver a execução no seu contexto conversacional.*
- O link do drawer abre a visão da sessão (Épico 4) ancorada nela; trace sem ID de sessão mostra "sem sessão", com honestidade.

**Adiado:** filtros salvos · exportação da lista em CSV · exibição de custo por span (o motor tem os tokens por span onde houver instrumentação).

---

## Épico 4 — Aba Sessions

**Objetivo.** Conversas como objetos de primeira classe: traces agrupados em sessões, com métricas agregadas e uma visão de conversa legível. É aqui que mora o "ler o que o agente realmente disse" — a camada mais profunda de confiança.

### T11 — Read-model de sessões e agregados
- Sessões derivadas dos traces armazenados, agrupados por ID de sessão; agregados por sessão: nº de traces, status ("com erro" se qualquer trace falhou), duração somada, tokens somados, **custo somado (soma dos custos dos traces — fecha por construção)**, início (primeiro trace), última atividade.
- Uma sessão está "viva" enquanto traces novos ainda podem chegar — sem flag artificial de "encerrada" na v1; ordenação cronológica pelo início de cada trace; chegadas fora de ordem se reordenam naturalmente.
- Endpoint de listagem espelha o T10: filtros (período, agente, status), paginação; o de detalhe devolve a cadeia ordenada de traces + agregados.
*Habilita: US21–US23.*

### US21 — Lista de sessões
*Como gestor do cliente, quero navegar pelas conversas dos meus agentes (sessões) com seus totais — traces, duração, tokens, custo — para ver a atividade no nível da conversa, do jeito que meus clientes a vivem.*
- Colunas: ID da sessão, agente (+ caminho), nº de traces, status, duração total, tokens, custo (R$), início.
- Filtros: período, agente, status; paginação; estados vazios honestos.
- Semântica de período definida: a sessão entra no filtro pelo **horário de início** (traces que cruzam a borda do período ficam com a sessão — regra documentada).

### US22 — Drawer da sessão: a visão de conversa
*Como gestor do cliente, quero abrir uma sessão e ler a conversa — a cadeia cronológica de execuções com seu conteúdo — para ver exatamente como o agente tratou o meu cliente.*
- Linha de métricas agregadas (traces, duração, tokens, custo).
- Cadeia cronológica dos traces da sessão: cada entrada mostra hora, status, duração, custo e o **conteúdo (entrada/saída) legível em sequência** — a sessão se lê como uma transcrição.
- Cada trace da cadeia é clicável → drawer completo do trace (US19), e volta (a navegação preserva o contexto — o drawer sem pilha de "voltar" do mock é uma lacuna de UX conhecida, a corrigir no produto real).

### US23 — Custo de sessão consistente com o billing
*Como gestor do cliente, quero que o custo da sessão visivelmente some a partir dos seus traces, para que todo nível do produto conte a mesma história de dinheiro.*
- Custo da sessão = soma exata dos custos dos traces; arredondamento conforme a regra do T5; nenhum caminho de cálculo paralelo.

**Adiado:** sessões de voz (segunda linha de métricas: p95 voz→voz, interrupções, quedas, minutos) · anotações e compartilhamento de sessão · sinais de qualidade da conversa.

---

## Épico 5 — Billing: Fechamento do Mês

**Objetivo.** Com traces armazenados e já carimbados com preço (Épicos 1–2), o faturamento entra em cena: os meses fecham em snapshots completos de auditoria, reproduzíveis — a base da fatura. O custo já é imutável por trace desde a gravação; aqui ele é somado, congelado como extrato e vira compromisso.

### T6 — Ciclo de vida do mês e fechamento com auditoria completa
Máquina de estados por período: **aberto → fechado**. O fechamento gera um snapshot imutável que guarda **tudo que foi usado para calcular a fatura**.
- Períodos de mês-calendário; fechamento depois do fim do mês (gatilho automático vs. iniciado pelo admin = QA4; sem mecânica de carência na v1).
- O snapshot contém: os registros de uso em nível de trace, com as quantidades de tokens (a granularidade mais fina — os próprios traces); as versões exatas de preço aplicadas — que já estão **carimbadas trace a trace** (e são copiadas para o snapshot, não referenciadas); a saída do cálculo linha a linha e todos os agregados; a regra de arredondamento e a versão da lógica de cálculo; as exceções (sem preço / excluídos, com motivo e quem decidiu); timestamp do fechamento, gatilho e marca d'água da ingestão.
- **Teste de aceite de reprodutibilidade:** rodar o motor de novo sobre os insumos do snapshot reproduz as saídas ao centavo.
- O que o cliente vê é projeção do snapshot; o que guardamos é o pacote inteiro.
- Depois do fechamento: uso datado dentro do mês entra em quarentena como exceção visível ao admin (nunca é somado em silêncio); carimbo de pendentes daquele mês é bloqueado (só via reabertura); reagregação bloqueada.
- Fechamento bloqueado enquanto houver trace com 'preço pendente' no período.
- Reabertura existe no motor: auditada (quem/quando/por quê), gera nova **versão** de snapshot, as anteriores nunca somem — só via runbook na v1.
- **Regra canônica:** em mês fechado, o snapshot manda; traces em quarentena pós-fechamento são divulgados ('N execuções chegaram após o fechamento') — nunca somados em silêncio, nunca escondidos.
*Habilita: a validação da fatura (Épico 6) e a geração da fatura real.*

### US5 — Visibilidade do fechamento (admin)
*Como admin da plataforma, quero saber quando o mês fechou e ver o resumo do extrato final (ou o motivo do bloqueio), para gerar a fatura real com números que eu sei que são definitivos.*
- Notificação do resultado (fechado com total R$ X / bloqueado por pendências); extrato congelado recuperável na íntegra — ele é A base da fatura; mês reaberto mostra todas as versões com a nota de auditoria.

### US6 — Gestor vê o status do período com honestidade
*Como gestor do cliente, quero que toda tela deixe claro se estou olhando um mês fechado (final) ou em andamento (parcial), para nunca tratar número provisório como fatura.*
- Mês fechado rotulado como final; mês corrente marcado sem margem de dúvida como "em andamento — dados parciais" (com o timestamp da US2). Número de mês fechado bate com o snapshot exatamente, para sempre.

**Adiado:** tela de reabertura/ajustes com aprovação · créditos e ajustes manuais como linhas de extrato.

---

## Épico 6 — Aba Billing: Validação da Fatura

**Objetivo.** O gestor abre um mês fechado e confere — do total geral até qualquer linha — que a fatura é exatamente tokens × preço contratado. Prioridade nº 1 do produto.

### T7 — Camada de projeção do extrato
Camada de leitura que serve a aba Billing a partir dos snapshots (meses fechados) e dos agregados ao vivo (mês corrente).
- Mês fechado é servido **exclusivamente** do snapshot — nunca recalculado ao vivo.
- Os campos internos (US$, PTAX, markup, detalhe de exceções) não existem no schema de projeção — ausentes por construção, não escondidos pela UI.
- Responde com o status do período e a marca d'água de atualização (alimenta US2/US6).
- **Check automático de consistência no mês aberto:** agregados do billing ≡ soma dos custos carimbados dos traces (mesmo banco, mesmo carimbo — desvio é defeito).
*Habilita: US4, US6–US8, US10 e os épicos 7–8.*

### US7 — Visão do extrato mensal
*Como gestor do cliente, quero abrir um mês fechado e ver meu extrato: total em R$ e a quebra por agente, para que o primeiro número que eu conferir já bata com o total da fatura.*
- Seletor de mês (fechado = final; corrente = em andamento). Total no cabeçalho; tabela por agente com % do total; valores batendo com o snapshot ao centavo.

### US8 — Drill-down até a conta
*Como gestor do cliente, quero descer do total para qualquer agente → modelo → tipo de token, vendo quantidades, preços unitários e custo de cada linha, para eu mesmo refazer a conta de qualquer linha.*
- Cada nível mostra quantidade, preço contratado (R$/milhão) e custo — a visão "mostra a conta". Linha: agente × modelo × tipo de token → quantidade × preço = custo; os níveis-pai são somas exatas dos filhos (arredondamento documentado). Tipos de token: input, output, cache leitura, cache escrita. Os preços exibidos vêm do snapshot (conversa com a US4).

### US10 — Checagem de sanidade mês a mês
*Como gestor do cliente, quero o mês fechado lado a lado com o anterior (total e por agente), para enxergar anomalias na hora, antes de questionar a fatura.*
- Variação absoluta e %, total e por agente; só informativa na v1.

**Adiado:** fluxo de contestação · visão de drill diário (o motor guarda o diário).

---

## Épico 7 — Aba Billing: Tendências, Projeção e Composição (enxuta)

**Objetivo.** Sair de "a fatura está certa?" para "o gasto está sob controle, e o que vem por aí?"

### T8 — Séries temporais e cálculo de projeção
- Série mensal (total, por agente, por modelo) montada dos snapshots + mês corrente ao vivo — um total por mês, em todo lugar.
- Projeção: método definido e documentado — v1: run-rate linear (acumulado do mês ÷ dias completos decorridos × dias do mês). É estimativa derivada: nunca entra em snapshot, nunca aparece em mês fechado.
- Profundidade do histórico no lançamento limitada pelo backfill de ~49 dias: as tendências nascem rasas e engordam com o tempo.
*Habilita: US11–US12 (US13 adiada — ver Adiados).*

### US11 — Evolução do custo no tempo
*Como gestor do cliente, quero a evolução mensal do meu custo (total e por agente) ao longo do histórico disponível, para entender minha trajetória em vez de julgar cada mês isolado.*
- Gráfico + tabela; séries por agente ligáveis/desligáveis; mês em andamento visualmente distinto; valores fechando com o extrato de cada mês.

### US12 — Projeção do mês corrente
*Como gestor do cliente, quero um total projetado de fim de mês com base no consumo até agora, para antecipar a fatura e agir antes do fechamento, não depois.*
- Gasto até agora, total projetado e a base da conta em palavras simples; rotulada como estimativa sem margem de confusão; some quando o mês fecha; com menos de ~3 dias completos, "dados insuficientes para projetar".

---

### T9 — Métricas derivadas de composição
- **Economia de cache:** contrafactual "quanto custaria se as leituras de cache fossem cobradas como input normal" vs. o real, aos preços contratados (tratamento da escrita de cache explícito — QA7).
- **Mix de modelos:** participação de custo e de tokens por modelo, por agente e no total.
- **Participação dos segmentos ao longo dos meses** (motor pronto; a visão US9 foi adiada).
- Tudo derivado dos agregados de snapshot/ao vivo — sempre fechando com o total do mês.
*Habilita: US15 (US14/US16 adiadas — motor pronto; ver Adiados).*

### US15 — Visão de mix de modelos
*Como gestor do cliente, quero ver como o custo se divide entre modelos, por agente, para discutir com meu time se modelo caro está sendo usado onde um mais barato resolveria.*
- Participação de custo e tokens por modelo, com deslocamento mês a mês; "R$ médio por milhão de tokens" (taxa blended) por agente, para o mix ser interpretável.

---

## Épico 8 — Aba Billing: Exportação

### US17 — Exportar o extrato mensal
*Como gestor do cliente, quero baixar o extrato do mês fechado (resumo + quebras) como arquivo, para anexar a processos e relatórios internos.*
- PDF (apresentação) e CSV/XLSX (dados — as linhas da US8); renderizado do snapshot; carrega mês, status "final" e timestamp de geração. Mês em andamento: com marca d'água "parcial" ou bloqueado (decisão de design — QA13).

**Adiado:** envio agendado por e-mail · links de compartilhamento.

---

## Adiados — consolidado (pós-v1)

| Área | Item | Prontidão do motor na v1 |
|---|---|---|
| Billing — Validação | US9 — Custo por segmento de interação | Spans no contrato (T1) + série de segmentos no T9 — falta só a visão |
| Billing — Tendências | US13 — Destaques de variação | T8 tem as séries — falta só a visão |
| Billing — Composição | US14 — Composição visual · US16 — Economia de cache | T9 calcula (inclusive o contrafactual) — faltam só as visões |
| Reconciliação | US25 — Explicador 'uma história de dinheiro' | Essencial dobrado: regra canônica no T6, check no T7, deeplink na US7 |
| Ingestão | Fluxo de revisão de agentes novos | T3 já ingere agente desconhecido desde o dia 1 — falta só a tela |
| Ingestão | Tela de gestão de uso não classificado | T3 armazena e marca; atribuição mutável — falta só a tela |
| Ingestão | Política de retenção/expurgo e mascaramento (LGPD) | Postura explícita da v1: guarda tudo, sem máscara — decisão registrada |
| Ingestão | Canal de voz | T1 já carrega `channel`; voz entra como canal + tipos de span novos, sem migração |
| Preços | Tela de cadastro/alteração · visão de histórico | T4: schema versionado, constraints, runbook — falta só a tela |
| Preços | Análise interna de margem | T4 captura as colunas internas por versão desde o dia 1 — faltam só as visões |
| Preços | Construções contratuais (mínimos, faixas, taxas) | Motor novo quando priorizado |
| Motor | Tela de reabertura/ajustes + aprovações · créditos como linha | T6: reabertura auditada e versionada — runbook na v1 |
| Billing | Fluxo de contestação · drill diário | Snapshot guarda o nível de trace; diário armazenado |
| Tendências | Alertas de orçamento · projeções melhores · anomalias | Projeção do T8 e série diária existem |
| Composição | Recomendações · custo por conversa | As sessões já dão a contagem de conversas — candidata a antecipação |
| Exportação | Envio por e-mail · links | A renderização da US17 é a base |
| Traces | Filtros salvos · exportar lista · custo por span | O armazenamento tem os dados |
| Sessions | Métricas de voz · anotações · sinais de qualidade | Read-model extensível |
| Transversal | RBAC (papéis e hierarquia) · nomes de nível configuráveis | v1 é single-tenant; domínio/subdomínio já vão no contrato como strings |
| Transversal | Custos de infra/compute | O motor não deve chumbar "custo = tokens" |
| Transversal | Operação multi-tenant | Superada: o modelo é uma instância por cliente; revisitar só se operar N instâncias doer |

---

## Log de decisões

| # | Decisão | Implicação |
|---|---|---|
| 1 | Persona principal: gestor do lado do cliente | Tudo que o cliente vê é em R$ e em linguagem simples |
| 2 | Os quatro objetivos do gestor no escopo; validar fatura em 1º | Ordem: transparência → tendências → composição → exportação |
| 3 | O relatório é a base de uma fatura real | Reproduzir a fatura com exatidão = o coração da confiança |
| 4 | Preço contratado é dado armazenado, não cálculo | Tem markup; custo de mercado varia; T4 com versões por vigência |
| 5 | Contratos em R$; câmbio/PTAX é assunto interno | US$/PTAX/markup nunca chegam ao cliente; excluídos no schema (T7) |
| 6 | Período de faturamento = mês-calendário | Ciclo aberto → fechado; mês corrente sempre parcial |
| 7 | LangWatch é o conector entre agentes e plataforma | Uma fonte de ingestão para as três abas |
| 8 | Infra/compute fora da v1 | Só tokens; motor extensível a novas categorias |
| 9 | Controle de acesso e papéis adiados | v1: o cliente loga e vê os dados da sua instância |
| 10 | História adiada mantém as tech stories que a habilitam | Adia-se a tela, não a capacidade |
| 11 | Preço mantido direto no banco na v1 | A disciplina vai para o schema: versões imutáveis, constraints, runbook |
| 12 | Sem mecânica de carência | Trace atrasado = exceção em quarentena, resolvida por gente |
| 13 | O snapshot guarda TUDO que calculou a fatura | Auditoria completa e autocontida; reprodutibilidade é teste de aceite |
| 14 | Nome cru de ferramenta serve na v1 | Sem dicionário de rótulos amigáveis |
| 15 | Uma API, três partes/abas: Billing, Traces, Sessions | Um contrato de metadados com matriz campo × consumidor |
| 16 | Trabalho principal de Traces/Sessions: transparência e confiança | Custo por trace em primeiro plano; deeplink billing→traces é essencial |
| 17 | Mesmo modelo de acesso do billing; RBAC adiado | Escopo garantido no nível do motor |
| 18 | Conteúdo das conversas na íntegra, sem mascaramento | O contrato carrega os payloads; retenção fica como ponto aberto registrado |
| 19 | **Single-tenant: uma instância por cliente** | Isolamento vira isolamento de deployment; o nível "organização" da hierarquia cai |
| 20 | Domínio e subdomínio são strings simples | Tags informativas + filtros simples; sem cascata nem nomes configuráveis |
| 21 | Guardar tudo (traces, spans, payloads) — o LangWatch retém só ~49 dias | A plataforma é o arquivo permanente; o sync é crítico no tempo; o backfill fica limitado a ~49 dias (o que passou disso já era) |
| 22 | Agregados do billing derivam dos traces armazenados; uma precificação só | Um banco, um carimbo por trace — consistência entre abas por construção |
| 23 | Só agentes de texto na v1 | Voz adiada; o campo `channel` deixa a porta aberta |
| 24 | Ordem de construção reorganizada: Traces → Sessions → Billing | Segue a cadeia de derivação (trace é o átomo); a validação da fatura passa a chegar por último — troca consciente; IDs de histórias preservados |
| 25 | **Preço é carimbado no trace no ato da ingestão; carimbo imutável** | Preços (T4) viram o Épico 1 — pré-requisito do pipeline; mudança de preço só afeta traces futuros; correção de carimbo só via reabertura auditada; imutabilidade migra do fechamento para a escrita |
| 26 | Cortes v2.3: US9, US13, US14, US16 adiadas | Visões de análise; o motor que as alimenta (T8/T9) permanece na v1 |
| 27 | Reconciliação dobrada no essencial (v2.3) | Épico dedicado cortado; regra canônica → T6, check de consistência → T7, deeplink extrato→traces → US7; US25 adiada |
| 28 | (PoC) Correções de fundação no boilerplate antes do pipeline | adaptRoute com try/catch (erro vira 500 padronizado, processo não cai); registro de rotas v1 com glob ancorado e aguardado (`routesReady`); `MongoDb.disconnect` limpa o client e ganha `connectWithUri`; testes de banco usam o Mongo em memória do preset jest-mongodb via `MONGO_URL` (sem mongod local; config `.mjs` morta removida); tsconfig `module=node16` (build/typecheck voltam a funcionar) com ts-jest emitindo CJS só nos testes |
| 29 | (PoC) Dinheiro em inteiros de micro-centavos (µ¢, 1e-8 R$) | Preço = inteiro µ¢/milhão de tokens (fino o bastante para preços derivados de US$×PTAX×markup); custo carimbado = inteiro µ¢ (half-up no µ¢, produto intermediário em BigInt); somas exatas até 2⁵³ µ¢ ≈ R$ 90 mi (limite assertado); exibição half-up 2 casas com ajuste largest-remainder para as partes fecharem com o total (T5); nunca float em aritmética ou armazenamento |
| 30 | (PoC) Migrations/seed em runner mínimo próprio (Mongo não tem SQL) | `runMigrations(db, migrations)` exportado (jobs E testes de integração o executam), coleção `migrations` marca aplicadas; constraints do T4 viram unique indexes; troca de preço no meio do período e modelo sem preço já entram no seed; runbook de preço = script `npm run price:insert` (insert-only) |
| 31 | (PoC) Store em 3 coleções: `traces`, `spans`, `trace_contents` | Chave natural = `traceId` do LangWatch (idempotência do sync); escrita parcial-segura: spans/conteúdo primeiro, documento do trace por último como marcador de commit, sobras de execução interrompida são limpas no re-run |
| 32 | (PoC) Estado de precificação é campo próprio (`pricingStatus`), ortogonal ao `status` | `status` segue ok/erro (contrato T1, filtro T10); `pending_price` não polui o status de execução; pendente = qualquer tipo de token USADO sem preço vigente — nunca carimbo parcial, nunca custo 0 |
| 33 | (PoC) Re-sync de trace já ingerido atualiza SÓ atribuição | Operação `updateAttribution` estruturalmente sem campos de carimbo (invariante 7); janelas de sync são half-open `[from, to)`; detecção de buracos e alerta de retenção ficam como stub de log (T2 completo é pós-PoC) |
| 34 | (PoC) Sessão calculada no read (pipeline GROUP BY sessionId), não materializada | Agregados fecham por construção; atribuição da sessão = a do primeiro trace; período filtra pelo início da sessão (QA17); `lastActivity` = maior `finishedAt` |
| 35 | (PoC) Honestidade de custo com pendências em TODA projeção | Trace pendente: `cost_brl: null` (+`pricing_status`); sessão com pendência: `cost_brl: null` + `stamped_cost_brl_partial` + `pending_price_count` — nunca um total que se leia como R$ 0,00 final |
| 36 | (PoC) Exibição: linha em precisão cheia, total com 2 casas | Detalhe do trace mostra preço aplicado e custo por tipo de token em string BRL exata (`cost_brl_exact`); só totais exibidos arredondam (half-up); datas e filtros de período em UTC, janelas `[from, to)` |
| 37 | (PoC, pós-revisão) Rotas v1 registradas estaticamente | O auto-registro por fast-glob só funcionava sob tsx/jest (glob de `.ts` relativo ao cwd): o build compilado (`node dist`) quebrava no boot — confirmado empiricamente. Rota nova = 1 import + 1 linha em `v1-routes-setup.ts`; verificado com o servidor `dist` servindo os endpoints |
| 38 | (PoC, pós-revisão) `model` é atribuição mutável; flag `unclassified` derivada do documento armazenado | `updateAttribution` aceita `model` (correção re-agrupa billing e destrava reprocess de pendentes — nunca toca o carimbo); o flag é recomputado pelo repositório APÓS o merge (payload sem um campo não re-flagra correção feita no store, nem limpa flag com valor ainda ausente); traces pendentes persistem `pendingPrice.missingTokenTypes` (US3), limpo no carimbo; seed de preços idempotente (upsert) para o runner sobreviver a crash entre aplicar e registrar |
| 39 | (PoC) Vertical de exemplo do boilerplate removido | Sign-up/Account inteiro (core→rotas, com bcrypt/email-validator e specs), config JWT (schema + `.env*`), helper `safeParse` e deps órfãs (`neverthrow`, `uuid`, `bcrypt`, `validator`, `ts-node`) removidos — nada era consumido pelo PoC; os jobs deixam de exigir `JWT_SECRET`; suíte 115 testes verdes, build `dist` servindo e `POST /signup` respondendo 404 |
| 40 | Cliente LangWatch REAL implementado atrás da mesma interface (QA14 fechada) | `HttpLangWatchClient` (search paginado + detalhe N+1, schema zod tolerante, mapper → contrato T1); swap por configuração: `LANGWATCH_ENDPOINT`/`LANGWATCH_API_KEY` presentes → real, ausentes → fake (testes/demo offline); credenciais só em `.env*` (gitignored). Mapeamentos: sessão=thread_id, agent=metadata.agent∥service.name, cache tokens da metadata reservada (strings) com fallback para Σ spans, finished_at derivado de total_time_ms, trace multi-modelo → `model` indefinido (pendente/não classificado — nunca precificado pelo modelo errado; precificação por span fica como decisão pós-PoC). Validado ao vivo: 25 traces reais ingeridos, preços registrados via runbook, reprocess carimbou 12 (9 multi-modelo seguem pendentes com motivo), billing 2026-07 parcial fechando com Σ display |
| 41 | Fornecedor de traces é 100% trocável — port neutro + teste de arquitetura | Port renomeado para `TraceSourceClient`/`SourceTrace` (`data/interfaces/trace-source-client.ts`, shape = contrato T1); adapter do vendor confinado a `infrastructure/traceSource/langwatch/` e o fake (contrato) em `infrastructure/traceSource/`; composition root escolhe o vendor. `architecture-boundaries.spec.ts` FALHA o build se: o nome do vendor aparecer em core/data/presentation/common, ou se qualquer camada importar na direção errada (core→nada externo, data→só core, presentation→só core). Trocar de vendor = novo adapter + 1 linha no factory + env próprio — zero mudança em regra de negócio (o teste garante) |
| 42 | Agente e canal viram blocos denormalizados com versão e instância (omni e agentes escalam horizontalmente) | Contrato T1 e store: `agent {id, version?, instance?}` (substitui agentId) e `channel {type, version?, instance?}` — versão (build) e instância (réplica) são fatos do MOMENTO da execução, congelados no trace como o carimbo (nunca resolvidos de um registro mutável). Identidade continua `agent.id`/`channel.type` (filtros, sessões, billing agrupa por `agent.id`; quebra por versão é análise futura sobre dados já capturados); versão/instância ausentes não desclassificam. Convenção de metadata com fallback OTel semconv: `agent`∥`service.name`, `agent.version`∥`service.version`, `agent.instance`∥`service.instance.id`; `channel`, `channel.version`, `channel.instance` (deployment do omni). Migração 004 remodela traces existentes (só atribuição — carimbo intocado) e repõe índices (`agent.id`, `channel.type`); novo filtro `channel` no GET /traces |
| 43 | Convenção de armazenamento: campo opcional grava como `null`, nunca ausente | Todo documento mostra o schema completo no banco (pedido do usuário para inspeção). Domínio segue com `undefined`/`?`; o `null` é representação de storage aplicada na fronteira de escrita (mapper nomeia todas as chaves — blocos agent/channel e os 4 tipos de token sempre presentes — e o BSON serializa undefined→null); `unclassified`/`pendingPrice` limpos viram `null` (não `$unset`); trace pendente mostra `totalCostMicrocents: null` = custo EM ABERTO (nunca 0 — invariante 2 preservada); migração 005 uniformiza documentos legados (traces, spans, price_versions) sem tocar carimbos |
| 44 | OpenAPI/Swagger gerado dos schemas de projeção (fonte única de verdade) | Schemas zod ESTRITOS de resposta vivem na presentation (por feature, ao lado dos view-models, que são TIPADOS por eles — drift não compila); o documento OpenAPI 3.1 é gerado deles via `z.toJSONSchema` nativo e montado no composition root (`main/docs/openapi.ts`); UI + JSON em `/api/v1/docs` (registrado antes do middleware de content-type JSON). Testes de contrato parseiam as respostas REAIS com os schemas estritos (docs nunca mentem; campo vazado quebra a suíte) e a invariante 4 é checada também sobre o próprio spec |
| 45 | Spans embutidos no documento de conteúdo — collection própria eliminada | Decisão de produto: spans são consumidos SOMENTE na visualização do trace. Eles moram em `trace_contents.spans` (o payload detail-only), não na coleção quente `traces` (métricas+carimbo continuam mínimos para listas/sessões/billing) nem em coleção própria (3 coleções → 2; uma leitura a menos no detalhe; API pública inalterada — provado pelos testes de contrato). `SpanModel` perde o FK `traceId`; sessões projetam `spans` para fora do fetch de conteúdo; migração 006 embute os legados em ordem cronológica e derruba a coleção `spans` (constraint: reavaliar se custo por span ou busca de spans entre traces entrarem no produto) |
| 46 | `spanContents` fundido nos spans embutidos | O array paralelo era cicatriz do layout antigo (metadata e payload de span em lugares distintos); com tudo no mesmo documento, cada span carrega seu próprio `input`/`output` (null quando a fonte não instrumentou). Contrato da API acompanhou: span do detalhe expõe payload próprio, `content.span_contents` removido (schemas + testes de contrato atualizados); a projeção `{spans: 0}` do detalhe de sessão agora corta também os payloads de span (antes vazavam no fetch da cadeia). Migração 007 funde os legados; carimbos intocados |
| 47 | `traces` e `trace_contents` fundidos: um trace = um documento autocontido | Pedido do usuário, trade-off aceito conscientemente: agregações (sessões GROUP BY, billing $unwind) passam a carregar documentos completos do disco — REVISITAR no dimensionamento do QA15; risco do teto de 16MB por documento passa a existir para conversas gigantes. Ganhos: escrita do sync ATÔMICA (marcador de commit e limpeza de sobras eliminados por construção), detalhe em UMA leitura, modelo mínimo (2 coleções → 1 de traces). Mitigações: listas e cadeia de sessão projetam spans/payloads para fora; billing projeta cedo no pipeline. API pública inalterada (testes de contrato provam). Migração 008 funde e derruba `trace_contents` |
| 48 | Endpoints atualizados para o modelo final; billing quebra por VERSÃO do agente | Lista de traces e resumo de sessões expõem os blocos completos `agent {id, version, instance, domain, subdomain}` e `channel {type, version, instance}` (rollout visível sem abrir o detalhe); sem filtros novos (decisão do usuário); linhas do billing viram agente × **versão** × modelo × tipo de token (revisa a parte "billing agrega só por id" da decisão 42 — custo por release visível no extrato; total inalterado, consistência ≡ Σ carimbos mantida com a chave nova no teste). Sessões mantêm `last_activity_at` (poc.md/T11) e os campos de pendência (invariante 2) além das colunas da US21. Ajuste posterior: `domain`/`subdomain` saíram do bloco `agent` para a RAIZ dos itens de trace e sessão — são atributos do trace (decisão 20), não do agente |
| 49 | Billing summary recebe `year` e `month` como parâmetros separados (ambos obrigatórios) | Pedido do usuário: `GET /billing/summary?year=2026&month=6` substitui `?month=YYYY-MM` (desvio consciente do literal do poc.md); a resposta espelha a separação (`year`/`month` inteiros). Validação: ambos obrigatórios (400 MissingParam), ano 1970-9999, mês 1-12; semântica de mês-calendário UTC inalterada |
| 50 | Fatura como recurso de primeira classe: `GET /bills` lista as faturas (uma por mês-calendário UTC com ao menos um trace) | Pedido do usuário durante a UI da PoC: a tela de billing lista FATURAS, não meses — nomenclatura corrigida de ponta a ponta (`ListBillsUseCase`, `listBills()`, resposta `{bills: []}`). Cada item traz status do período (mês corrente sempre `in_progress`/parcial — invariante 8), contagens de traces carimbados e pendentes (pendentes fora do total — invariante 2), tokens e total ≡ Σ carimbos do mês (invariante 3; teste de integração pina a linha da fatura ao extrato). O extrato do mês continua em `GET /billing/summary?year&month` e é o detalhe aberto ao clicar na fatura |
| 51 | API entrega TODO valor derivado/exibido; front-end só renderiza | Pedido do usuário: nenhum processamento de dados no front. Três camadas: (a) traces são snapshots imutáveis → campos derivados CONSOLIDADOS no documento na ingestão (`tokensTotal`, `span.offsetMs`; migração 009 backfilla); (b) sessões e billing são read-models derivados → agregados calculados em tempo de consulta (agrupamento por agente do extrato, geometria das barras, contagens) — nunca armazenados; (c) formatação de exibição (pt-BR, R$, durações, datas, idade relativa, rótulos, geometria do waterfall, `total_pages`) vive nos view-models da presentation — campos `*_display`/`*_label` no contrato. Datas exibidas no fuso fixo UTC-3 (America/Sao_Paulo, sem DST desde 2019); formatação manual determinística, sem dependência de ICU. Displays de grupo do billing somam os centavos RECONCILIADOS das linhas — grupos fecham com o total como as linhas (T5) |
| 52 | Topologia de deploy dockerizada: 1 projeto compose POR CLIENTE + infra compartilhada mínima | Isolamento single-tenant no nível de deployment (invariante 5): cada cliente (hapvida/claro/vivo) é um projeto compose próprio (`compose.client.yml` + `clients/<nome>.env`) com API própria e instância LangWatch self-hosted própria (app pinado em `langwatch/langwatch:3.5.0` + postgres + redis + clickhouse — stack oficial atual, SEM OpenSearch; contêiner de workers separado como no upstream — `START_WORKERS=true` não funciona na imagem de produção). Compartilhados: um MongoDB (um database por cliente, `MONGO_DB_NAME`) e o mock do endpoint de discovery (`GET /resolve/:cliente` → `apiBaseUrl`), que a UI consulta ao trocar de cliente no seletor — a UI não conhece endereço de API. Segredos LangWatch por instância em `clients/*.env`; `LANGWATCH_API_KEY` vazio → sync usa o cliente fake de fixtures (QA14); preenchido após onboarding → cliente HTTP real via DNS interno do projeto |
| 53 | Massa de demonstração gerada por cliente, com custo por trace entre R$ 1 e R$ 100 | Pedido do usuário: dados realistas e variados por cliente. `packages/api/scripts/generate-demo-fixtures.mjs` gera fixtures determinísticas por cliente (perfis distintos de volume, modelo, agente, canal, sessão, duração, spans, tokens e status) em `demo-data/<cliente>/`, montadas no contêiner sobre o diretório de fixtures da imagem — a ingestão continua sendo a normal (carimbo no ato da gravação; o gerador NUNCA escreve no banco). Como o custo vem da tabela de preços, o gerador espelha o lookup as-of e dimensiona os tokens para acertar o custo alvo; para manter contagens de tokens plausíveis em toda a faixa foi registrado um modelo premium (`anthropic/claude-opus-4-8`, R$ 82,50/M input e R$ 412,50/M output) via o job de preços (invariante 9), e não por migração. Tráfego de 01/06 a 21/07/2026: junho fecha completo, julho é parcial. Sem traces `pending_price` nesta massa — o requisito era que todo trace tivesse custo |
| 54 | Dockerização em forma de produção: unidade de deploy 100% autocontida por cliente | Refina a decisão 52 rumo à produção: `compose.client.yml` passa a ser a ÚNICA unidade de deploy — api + mongo PRÓPRIO (volume próprio, auth opcional via env, sem porta no host) + stack LangWatch completa, sem rede compartilhada e sem infra pré-existente; N clientes = N aplicações do mesmo arquivo com N env files (`clients/example.env` é o contrato; arquivos reais fora do git). Nada — imagem, compose, aplicação, Makefile — conhece cliente algum: o Makefile vira genérico (`make up CLIENT=<nome>`), o bloco `build` e as fixtures de demo migram para `compose.dev.yml` (só dev), e o mock de discovery fica em `compose.shared.yml` como ferramenta de dev fora do deploy. Única mudança de código: a URI local do Mongo passa a aceitar credenciais opcionais (`authSource=admin`, retrocompatível). Dados dos 3 clientes demo re-sincronizados do LangWatch de cada um (fonte da verdade upstream; mongo compartilhado aposentado) |
| 55 | Endpoint de discovery era artefato de teste — descartado, não é feature futura | Corrige a premissa registrada nas decisões 52/54: o `GET /resolve/:cliente` existiu apenas para a UI de teste multi-cliente do PoC. Com a UI dentro da stack de cada cliente (mesma origem, decisão 54), o mock perdeu o único consumidor e foi removido do repositório junto com seus alvos de tooling. Nenhum componente futuro depende desse contrato; se algum dia um roteamento multi-cliente existir, será especificado do zero |
| 56 | Fase 1 do desacoplamento de storage: a troca de banco fica confinada a infrastructure + factories + config | Auditoria profunda (49 agentes, 0 bloqueadores no domínio) seguida de refatoração: (a) porta `Database`/`MigrationRunner` — `main/factories/database-factory.ts` é o ÚNICO lugar que nomeia um backend concreto; entry points consomem a porta; (b) catálogo de migrações Mongo movido para `infrastructure/database/mongodb/migrations` (cada backend é dono do seu catálogo); (c) violação de unicidade cruza a fronteira como `DuplicatePriceVersionError` tipado — nunca mais sniffing de texto de erro do driver; (d) regra de `unclassified` tem UMA definição (`deriveUnclassified`) compartilhada entre mapper e adapter; (e) provas dos invariantes viram SUITES DE CONTRATO das portas (`data/interfaces/*.contract.ts`), parametrizadas por harness — qualquer adapter futuro roda as mesmas provas; testes de rota ficam cegos de storage atrás de um único helper; (f) suite unitária não sobe mais mongod; (g) fitness tests novos impedem regressão: driver `mongodb` só dentro do adapter, camadas de negócio cegas de storage (testes incluídos), main sem imports profundos de storage fora do composition root. Fase 2 (adapter Postgres) fica trivial quando/se necessária |
| 57 | Totais de tokens da plataforma incluem os QUATRO tipos cobrados — divergência com o card "Tokens" do LangWatch é esperada | O headline do dashboard do LangWatch soma apenas prompt+completion; a plataforma soma input+output+cache_read+cache_write, porque tokens de cache têm preço contratado em R$ e o número de tokens exibido precisa fechar com o R$ ao lado (invariante 3 é computado sobre os quatro tipos). Ex. real (cliente vitoria): LangWatch 18,7M = input+output 18.704.574; plataforma 21.939.800 = + cache_read 2.619.690 + cache_write 615.536. Não é bug de sync — o extrato da fatura mostra a decomposição por tipo. Registrado no README (seção LangWatch) para não virar chamado de suporte |
| 58 | Camadas renomeadas: `src/core` → `src/domain` e `src/data` → `src/application` | Pedido do usuário: os nomes do boilerplate (estilo Manguinho) confundiam — dois diretórios `useCases` sem indicar que um guarda contratos e o outro implementações. Rename puro via `git mv` + reescrita de imports relativos; nenhuma mudança de semântica: `domain/useCases` = interfaces + modelos (zero dependências), `application/useCases` = implementações `Db*` sobre as portas de `application/interfaces`. `architecture-boundaries.spec.ts` atualizado para os novos nomes (direção de dependência e cegueira de storage/vendor seguem enforçadas por teste). Referências históricas a `core/`/`data/` em decisões anteriores (41, 56) permanecem como registro da época |
| 59 | Ingestão contínua lê DIRETO do ClickHouse do LangWatch (mesma rede do compose), não da API HTTP | Resolve QA1 (frescor) e o teto da busca (~100 traces/janela + N+1 de detalhe por trace, inviável no volume esperado). Terceiro adapter do port `TraceSourceClient` (`infrastructure/traceSource/langwatch/clickhouse/`): `trace_summaries` + `stored_spans` em SQL batelado; fidelidade verificada por diff campo-a-campo de um trace ingerido pelos DOIS caminhos (0 divergências). Acoplamento ao schema interno: (a) pinado pela tag da imagem no compose; (b) tripwire em runtime — o worker checa a versão de migração (`goose_db_version` = 35) no startup e se recusa a rodar (crash-loop visível) se o schema mudou; upgrade do LangWatch = revalidar SELECTs/mapper + atualizar a constante. Cadeia do factory: ClickHouse → HTTP → fake; `make sync` manual também usa o ClickHouse quando configurado (sem teto). O cliente HTTP fica como fallback/spot-check |
| 60 | Sync recorrente = sidecar `sync-worker` com loop de watermark (cursor persistido), não cron | Mesmo padrão do `langwatch-workers` (mesma imagem, outro command); viaja com o deploy de cada cliente, `restart: unless-stopped`. Loop: lê cursor → batches ≤ `SYNC_BATCH_SIZE` (memória limitada por construção, qualquer backlog) → ingere TUDO → só então avança o cursor (`sync_state` no Mongo). Cursor = `(UpdatedAt, TraceId)` do ClickHouse — tempo de ESCRITA na fonte, não do trace: chegada atrasada fica sempre à frente do cursor (estruturalmente impossível de perder). Crash/SIGKILL no meio do batch: cursor não avançou, re-leitura é deduplicada por `insertIfAbsent`. SIGTERM: termina o batch corrente e sai limpo (`stop_grace_period: 60s`). Loop não se sobrepõe por construção (um ciclo termina antes do próximo). Erros transitórios: retry com backoff dobrado; tripwire de schema: fatal |
| 61 | Quarentena de 15 min antes de ingerir (`SYNC_QUIET_PERIOD_SECONDS=900`) | O LangWatch monta traces incrementalmente (spans pingam) e o carimbo é imutável — sincronizar cedo demais congelaria contagens parciais de tokens. Só entram linhas sem atualização há 15 min; frescor do billing/traces fica ~15-16 min atrás do vivo. Escolha do usuário (23/07/2026) entre 1/5/15 min |
| 62 | Linha venenosa: skip + log, nunca travar o sync | Linha que falha validação/mapeamento é pulada com o `traceId` no log e o cursor avança por cima dela (senão um registro malformado pararia a ingestão para sempre). Escolha do usuário (23/07/2026) contra a alternativa halt-loudly; o log é a trilha de recuperação |
| 63 | Reprocess com gatilho duplo | (a) Imediato: `price:insert` roda o reprocess ao final (preço novo re-carimba na hora o que destravou); (b) backstop: o worker varre a cada `REPROCESS_INTERVAL_SECONDS` (default 1h). Decisão do usuário (23/07/2026): "both" |
| 64 | Retenção do LangWatch é configurável — subir de 49 dias no onboarding | Descoberta (instância viva 3.5.0): 49 = `PLATFORM_DEFAULT_RETENTION_DAYS` carimbado POR LINHA no ClickHouse quando a tabela `RetentionPolicy` (Postgres) está vazia; overrides por org/team/project (49 dias a ~179 anos, semanas inteiras) via `/settings/data-retention`, com re-carimbo retroativo. Novo passo de onboarding recomendado: override org-level de `traces` (ex.: 1 ano) — relaxa o prazo de perda de dados sem tocar na invariante 6 (nossa store segue sendo o arquivo permanente). Decisão 21 segue valendo como default |
| 65 | Compose fatiado por PAPEL: `compose.module.yml` (api+ui+sync-worker) + `compose.langwatch.yml` (conector) + `compose.mongodb.yml` (banco) | Substitui o `compose.client.yml` monolítico; os três arquivos se fundem no MESMO projeto por cliente (rede/DNS/volumes idênticos — config renderizada byte-idêntica, verificada por diff; zero recriação de contêineres). Regra estrutural: cada acoplamento mora no arquivo que o introduz — o arquivo do conector carrega os fragments de env/depends_on que ele impõe ao módulo (LANGWATCH_*, clickhouse healthy), o do banco idem (mongo healthy); o módulo não nomeia serviço de conector nem de banco. `MONGO_DB_HOST/PORT` viram env-driven (default = mongo in-project). Futuro já comportado: mais conectores = novos `compose.<conector>.yml` irmãos; banco externo (ex.: Atlas) = tirar `compose.mongodb.yml` da cadeia + apontar env — sem editar arquivo nenhum. Makefile centraliza a cadeia em `COMPOSE_FILES` |
| 66 | `sync-worker` movido do módulo para o arquivo do conector (`compose.langwatch.yml`) | Pedido do usuário (27/07/2026): a granularidade de escala horizontal do ingestor é a do LangWatch — o worker existe para drenar o ClickHouse DESTE conector, então outro stack LangWatch = outro ingestor, e o serviço mora no arquivo que define o conector (refina a decisão 65: módulo = api+ui). Consequências: (a) cadeia sem conector não tem worker nenhum (antes: worker ocioso) — `make sync` sobre fixtures segue como caminho offline; (b) o fragment `depends_on: mongo` do worker saiu de `compose.mongodb.yml` e não foi recriado — compose quebra tanto com fragment sobre serviço indefinido (cadeia módulo+banco) quanto com depends_on para serviço inexistente (conector+banco externo); o ordering de boot fica coberto pelo server selection de 30s do driver mongo + `restart: unless-stopped`. Config renderizada da cadeia completa ficou idêntica exceto a remoção desse depends_on (verificado por diff das 4 combinações de cadeia) |
| 67 | Renomeações: serviço `sync-worker` → `trace-ingestion-worker`; arquivo `compose.langwatch.yml` → `compose.connector.yml` | Pedido do usuário (27/07/2026), na sequência da decisão 66: o serviço ganha nome que diz o que faz (ingestão de traces), e o arquivo do conector passa a ser nomeado pelo PAPEL, não pelo vendor — trocar de conector no futuro = outro `compose.connector.yml` no mesmo slot da cadeia (refina a parte "sibling compose.<conector>.yml" da decisão 65). Identificadores internos do código (`SyncWorkerEnvironmentVariables`, `syncWorkerSettings`, env vars `SYNC_*`, `run-sync-loop.js`) ficam — descrevem a atividade de sync, não o contêiner. `make up`/`up-prod` ganham `--remove-orphans`: sem isso o rename deixaria o contêiner antigo rodando junto do novo — dois ingestores disputando o mesmo cursor de watermark |
| 68 | Rename estendido ao código (reverte a ressalva da decisão 67, a pedido do usuário) | Env vars `SYNC_INTERVAL_SECONDS`/`SYNC_BATCH_SIZE`/`SYNC_QUIET_PERIOD_SECONDS` → `TRACE_INGESTION_*` (contrato de env quebra: env files de clientes existentes atualizados junto — cliente1/cliente2 — e `1-init-client-env.sh` escreve os nomes novos); `SyncWorkerEnvironmentVariables` → `TraceIngestionWorkerEnvironmentVariables`; `syncWorkerSettings` → `traceIngestionWorkerSettings`; entry point `run-sync-loop.ts` → `run-trace-ingestion-loop.ts` (comando do compose atualizado — exige imagem rebuildada antes do próximo `up`); npm script `sync:loop` → `ingestion:loop`; prefixo de log "Sync worker:" → "Trace ingestion worker:". Ficam com nome de sync o que É sync (atividade): `sync-factory.ts`, use cases `Sync*`, `run-sync.js` (backfill manual), linhas de log "Sync: batch", `REPROCESS_INTERVAL_SECONDS`. Verificado: tsc limpo, 201/201 testes, config das cadeias renderiza os knobs novos, imagem rebuildada contém `run-trace-ingestion-loop.js` |
| 69 | Limpeza de código morto (27/07/2026): removidos `openapi.json`/`api-docs.html` da raiz, `populate-langwatch.sh`, ambiente `staging`, deps npm não usadas e o lockfile órfão de `packages/api` | Auditoria de não-uso: os artefatos de docs da raiz eram cópias estáticas do commit inicial — o documento vivo é gerado em memória (`main/docs/openapi.ts`) e servido em `/api/v1/docs`; `populate-langwatch.sh` foi superado pelo fluxo `4-seed-demo-data.sh` + `push-demo-to-langwatch.mjs`; nada em repo nenhum seta `ENVIRONMENT=staging` (enum + `.env.staging` removidos — `production`/`test`/`development` ficam); deps removidas de `packages/api`: `cors` + `@types/cors` (middleware CORS é feito à mão), `@types/mongodb` (driver v7 traz os próprios tipos), `@jest/globals` (nenhum import; segue como dep transitiva do jest), `git-commit-msg-linter` (nenhum hook instalado); `packages/api/package-lock.json` (lockfileVersion 1) era resquício do boilerplate — o lockfile da raiz governa o workspace. Verificado: tsc limpo, 201/201 testes, UI carrega sem erros de console |

---

## Registro de questões abertas

| ID | Área | Questão | Por que importa |
|---|---|---|---|
| QA1 | Ingestão | ~~Frequência do sync — diário basta, ou intradiário?~~ **RESOLVIDA (23/07/2026, decisões 59–61)**: sync contínuo — o sidecar `sync-worker` alcança o tip e re-verifica a cada `SYNC_INTERVAL_SECONDS` (default 60s); frescor efetivo ≈ quarentena de 15 min + intervalo. A pressão dos 49 dias também relaxa via override de retenção no onboarding (decisão 64) | Resolvida pela ingestão contínua (T2 forma contínua) |
| QA4 | Fechamento | Gatilho do fechamento: automático no dia 1 ou pelo admin? | Tendência: pelo admin na v1 (a fatura já é gerada manualmente) |
| QA5 | Fechamento | Fechamento bloqueado: a fatura espera, ou há prazo com decisão forçada? | O SLA operacional entre fim do mês e emissão |
| QA6 | Preços | Modelo novo aparece antes do preço acordado: retém como "sem preço" ou cobra um padrão? | v1 assume reter; mexe no timing de receita |
| QA7 | Composição | Escrita de cache: parte da economia ou custo simples no contrafactual? | Honestidade da metodologia do T9 |
| QA8 | Preços | Preço é por modelo apenas (não por agente) — confirmar | Mantém o T4 simples |
| QA9 | Preços | Quem tem acesso ao banco para mexer em preço; confiança + versões imutáveis bastam? | Governança do dado mais sensível do sistema |
| QA10 | Billing | A fatura real soma impostos/itens depois do total da plataforma? | O extrato precisa dizer o que cobre ("total de serviços antes de impostos") — mantida aberta por decisão |
| QA13 | Exportação | Exportar mês em andamento: com marca d'água ou bloqueado? | Detalhe de design da US17 |
| QA14 | Ingestão | ~~A API do LangWatch entrega spans e payloads com fidelidade? Limites de paginação e tamanho?~~ **RESOLVIDA (spike em 20/07/2026 contra a instância self-hosted)**: `POST /api/traces/search` pagina por pageSize/pageOffset com `totalHits`, mas devolve spans VAZIOS — o detalhe (`GET /api/traces/{id}?format=json`) é obrigatório por trace (N+1; ok no volume atual, rever com QA15). Timestamps em epoch ms; trace NÃO tem finished_at (deriva de total_time_ms). Tokens de cache só em metadata reservada (strings) e/ou métricas de span. Sessão = `thread_id`; agent/channel/domain/subdomain via convenção de metadata (a formalizar com os times). Payloads chegam como enviados (inclusive já mascarados pelo emissor). **Novo ponto aberto derivado: traces multi-modelo existem (agentes claude-code) — v1 os mantém como pending/não classificado em vez de precificar errado; precificação por span é decisão de produto pós-PoC** | Spike concluído; cliente real implementado atrás da mesma interface |
| QA15 | Armazenamento | Estimativa de volume: traces/dia × tamanho de payload → dimensionamento e classe de storage para conteúdo | Arquitetura do T3; metas de desempenho do T10 |
| QA16 | Ingestão | Confirmar a retenção exata do LangWatch (49 dias? igual para todo tipo de dado?) | É o prazo fatal do qual toda a proteção do sync deriva |
| QA17 | Sessions | Semântica de período da sessão: pelo horário de início (proposta) — confirmar | Comportamento do filtro da US21 na virada do mês |
| QA18 | Traces | Conversas/payloads muito longos: regra de truncamento/carregamento sob demanda nos drawers | UX e desempenho da US19/US22 |
| QA19 | Preços | Regra do carimbo: preço vigente na **data do trace** (proposta) vs. no momento do sync — confirmar | Trace de 31/07 ingerido em 01/08 após troca de preço: qual versão vale? A proposta preserva correção contratual + imutabilidade |

*(As QA2/QA3 da v1 — escopo do backfill e alcance da API — foram resolvidas pela decisão 21: backfill = o que ainda estiver dentro da janela de ~49 dias no lançamento.)*
