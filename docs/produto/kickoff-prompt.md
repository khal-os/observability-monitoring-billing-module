# Kickoff prompt — cole isto como primeira mensagem no Claude Code

---

Leia primeiro o CLAUDE.md na raiz e depois, na íntegra:
- docs/produto/backlog-v2.3.md (a fonte da verdade do produto)
- docs/produto/poc.md (o escopo exato deste PoC e o roteiro de demo)

Depois explore o boilerplate e me diga, ANTES de escrever código:

1. Um mapa curto do repo: stack, estrutura, como se criam migrations,
   onde vivem rotas/handlers, padrão de testes, como rodar localmente.
2. Seu plano de implementação do PoC mapeado para ESTA estrutura, na ordem
   do docs/produto/poc.md (T4 → fake LangWatch → sync+carimbo → store →
   endpoints → billing summary), com os arquivos que pretende criar/alterar
   em cada passo.
3. Qualquer conflito entre o boilerplate e os invariantes do CLAUDE.md
   (ex.: dinheiro em float, ausência de camada de jobs) — aponte e proponha
   a solução antes de seguir.

Regras de trabalho:
- Respeite as convenções do boilerplate; não introduza um estilo paralelo.
- Implemente na ordem do plano, um passo por vez, com testes a cada passo —
  o teste de consistência (billing ≡ Σ custos carimbados) e o teste de
  imutabilidade do carimbo (troca de preço não reprecifica trace antigo)
  são obrigatórios.
- Dinheiro nunca em float.
- Onde uma escolha depender de QA14 ou QA19, marque no código com
  comentário `// QA14:` / `// QA19:` e siga com o default documentado
  (QA19: preço vigente na data do trace).
- Ao tomar decisões novas de implementação, acrescente-as ao log de
  decisões em docs/produto/backlog-v2.3.md.

Quando o plano estiver acordado, comece pelo passo 1 (T4).
