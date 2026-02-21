# Lista de Acoes Prioritarias -- CredPositivo (v4 FINAL)

**Data:** 13 de fevereiro de 2026
**Atualizado com:** Agente AI e o especialista. Sem closer humano. Sem handoff.
**Base:** Consolidacao de auditorias + design v3 FINAL do agente AI

---

## Resumo Executivo

O CredPositivo esta substituindo o BotConversa por um **agente AI que e o especialista de credito**. O agente investiga, educa, convence, direciona ao site, acompanha e faz upsell. Nao existe closer humano no fluxo. Humano e apenas fallback interno invisivel.

**Funil final:**
```
Instagram → Bio → WhatsApp (Agente AI = especialista) → Site (compra) → Agente AI (acompanha + upsell)
```

**3 frentes paralelas:**
1. **Corrigir o que esta quebrado agora** (site, compliance, confianca)
2. **Implementar o agente AI** (substituir BotConversa)
3. **Reconstruir infraestrutura** (seguranca, dashboard, admin)

---

## FAIXA 1 -- EMERGENCIAL (1-2 dias)
*Impacto: eliminar riscos legais e destruidores de confianca. Custo: zero.*

| # | Acao | Por que e urgente |
|---|------|------------------|
| 1 | **CORRIGIR COMPLIANCE DO BOT** -- Remover todas as promessas de "aumento de score" e "liberacao de credito" do fluxo BotConversa. Reformular para: "Analise e reconstrucao do perfil bancario". | **Risco legal real.** Propaganda enganosa (CDC). Bot sera substituido, mas ate la precisa estar correto. |
| 2 | **Corrigir CNPJ nos termos de uso** -- Substituir 00.000.000/0001-00 pelo CNPJ real | Lead que verifica os termos ve CNPJ falso = golpe. |
| 3 | **Remover links para cadastro, login e dashboard** da pagina bio | Caminhos quebrados (dashboard 404, localStorage). |
| 4 | **Simplificar bio para 2 CTAs**: "Fazer Diagnostico" (→ landing) + "Falar com Especialista" (→ WhatsApp) | 100% dos leads vao para caminhos funcionais. |
| 5 | **Corrigir botoes "#" da landing page** -- Redirecionar para WhatsApp | CTAs principais da landing estao mortos. |
| 6 | **Adicionar prova social na bio**: "15.000+ clientes atendidos" + 1 depoimento real | Bio sem validacao = zero confianca. |

**Resultado esperado:** Risco legal eliminado, caminhos quebrados removidos, CTAs funcionando.

---

## FAIXA 2 -- RAPIDO / ALTO IMPACTO (1-2 semanas)
*Impacto: confianca visual + preparar terreno para o agente AI. Custo: baixo.*

| # | Acao | Por que importa |
|---|------|-----------------|
| 7 | **Substituir fotos stock dos depoimentos** por depoimentos reais (com autorizacao) | Fotos Unsplash com "compra verificada" e contraditorio. |
| 8 | **Adicionar foto/video real do fundador (Augusto Bezerra)** na bio e landing page | O agente AI se apresenta como Augusto. Site precisa mostrar quem e. |
| 9 | **Adicionar precos de TODOS os produtos na landing page** (diagnostico, limpa nome, rating) | Agente NAO menciona preco. Site precisa ter tudo claro. |
| 10 | **Iniciar plano de conteudo Instagram** (semana 1 do calendario de 7 dias) | Gera trafego para bio → WhatsApp → agente AI. |
| 11 | **Unificar identidade visual** -- Aplicar mini design system em bio e landing | Cada pagina parece um site diferente. |
| 12 | **Adicionar FAQ + selo LGPD + pagina de comparacao ("por que somos diferentes")** | Lead que vem do agente para o site precisa encontrar respostas claras. |

**Resultado esperado:** Site pronto para receber trafego do agente AI com confianca e transparencia.

---

## FAIXA 3 -- AGENTE AI (2-4 semanas)
*Impacto: substituir BotConversa pelo novo modelo. Custo: medio-alto.*

| # | Acao | Por que importa |
|---|------|-----------------|
| 13 | **Implementar agente AI especialista** no WhatsApp (substituir BotConversa). Baseado em: `06-ai-consultation-design.md` (v3), `07-compliance-guardrails.md` (v2) | Core do funil. Agente e o especialista: investiga, educa, convence, direciona ao site, acompanha, faz upsell. |
| 14 | **Implementar bloco antiban** no inicio de toda conversa | Pedir para salvar contato antes da triagem. Aumenta entregabilidade WhatsApp. |
| 15 | **Implementar sistema de webhooks** (signup_completed, purchase_completed, purchase_abandoned, consultation_timeout, link_sent_no_action) | Agente reage a eventos do site. Follow-up + upsell automatico. Ver `09-webhook-followup-playbook.md` (v2). |
| 16 | **Implementar logica de produtos** (diagnostico → limpa nome → rating) com recomendacao por perfil | Negativado → diagnostico + limpa nome. Nome limpo → rating (inclui diagnostico). |
| 17 | **Implementar regras de preco** (1x conceitual, 2x link, 3x orienta site) | Nunca evadir. Nunca travar conversa. |
| 18 | **Implementar cadeia de upsell pos-compra** | Diagnostico → limpa nome/rating. Limpa nome → cartao parceiro + rating. Rating → acompanhamento. |
| 19 | **Implementar fallback interno** para escalation invisivel ao usuario | Humano assume como Augusto em casos extremos. Ver `08-fallback-escalation.md`. |
| 20 | **Implementar UTM tracking** nos links enviados pelo agente | Medir conversao: quantos leads vao ao site vs. quantos compram. |
| 21 | **Criar destaques do Instagram** organizados | Complementa conteudo e reduz perguntas antes do WhatsApp. |

**Resultado esperado:** BotConversa desativado. Agente AI operando como especialista completo: investigacao + educacao + direcionamento ao site + follow-up + upsell. Sem closer humano no fluxo.

---

## FAIXA 4 -- ESTRUTURAL (1-3 meses)
*Impacto: reconstruir infraestrutura tecnica. Custo: alto.*

| # | Acao | Por que importa |
|---|------|-----------------|
| 22 | **RECONSTRUIR SEGURANCA** -- (a) Remover credenciais hardcoded, (b) Backend real para auth, (c) Eliminar localStorage, (d) Hash de senhas | Violacao de LGPD. Qualquer pessoa com DevTools ve credenciais. |
| 23 | **Desenvolver dashboard funcional** do cliente | Hoje 404. Cliente precisa ver resultado do diagnostico online. |
| 24 | **Reconstruir admin panel** com gestao real (clientes, diagnosticos, status, pipeline, historico do agente) | Admin atual e login hardcoded. Precisa gerenciar fluxo AI → site → servicos. |
| 25 | **Integrar CRM + WhatsApp API oficial** + agente AI em stack unificada | Historico unificado: conversa do agente + eventos do site + servicos. |
| 26 | **Dashboard do agente AI** — metricas de conversao, follow-up, upsell, fallback | Monitorar performance do agente e identificar pontos de melhoria. |
| 27 | **Sistema de referral** — clientes indicam e recebem beneficio | Clientes que passaram pela experiencia consultiva tendem a indicar mais. |

**Resultado esperado:** Infraestrutura segura e profissional. Stack unificada: AI + site + CRM + admin + metricas.

---

## Mapa de Riscos

| Risco | Severidade | Acao | Faixa |
|-------|-----------|------|-------|
| **Propaganda enganosa** — BotConversa promete aumento de score | CRITICA | #1 (corrigir), #13 (substituir) | 1 → 3 |
| **LGPD** — senhas em texto puro, dados em localStorage | CRITICA | #22 | 4 (mudar senha como paliativo) |
| **Credenciais expostas** — admin/senha hardcoded | CRITICA | #22 | 4 (mudar senha agora) |
| **CNPJ falso** | ALTA | #2 | 1 |
| **Depoimentos falsos** — fotos stock | MEDIA | #7 | 2 |
| **WhatsApp ban** — sem bloco antiban | MEDIA | #14 | 3 |

---

## Funil Final

```
Instagram → Bio (/bio)
                |
        [2 CTAs: Landing + WhatsApp]
                |
    +-----------+-----------+
    |                       |
Landing Page            WhatsApp (AGENTE AI)
    |                       |
    |              [Fase 0: Antiban]
    |              [Fase 1: Acolhimento]
    |              [Fase 2: Investigacao]
    |              [Ebook gratuito]
    |              [Fase 3: Educacao + Causas]
    |              [Fase 4: Direcionamento]
    |                       |
    +----→ Site (compra) ←--+
                |
        [signup_completed]
        [purchase_completed]
        [purchase_abandoned]
                |
        (webhooks → agente AI reage)
                |
        [Agente: acompanha + upsell]
                |
        Diagnostico → Limpa Nome → Rating
                |
        [Agente continua ate conversao total]
```

**Diferenca fundamental v4:** Nao existe closer humano. O agente e o especialista. Ele conduz TUDO: conversa, follow-up, upsell, acompanhamento. O site fecha a venda. Humano e apenas fallback interno invisivel.

---

## Metricas de Acompanhamento

| Metrica | Como Medir | Meta |
|---------|-----------|------|
| Taxa de clique na Bio | UTM + analytics | >40% |
| Leads que iniciam conversa | WhatsApp API | Rastrear |
| Taxa antiban (salvou contato) | Agente logs | >70% |
| Taxa conclusao consulta (Fase 0→4) | Agente logs | >50% |
| Leads que recebem link do site | Agente logs | >40% dos que iniciam |
| Taxa de signup apos link | Site analytics | >30% |
| Taxa de compra apos signup | Site analytics | >40% |
| Taxa de recuperacao de abandono | Agente follow-up | >15% |
| Taxa de upsell pos-diagnostico | Agente + site | >20% |
| Taxa de upsell pos-limpa nome | Agente + site | >15% |
| Taxa de fallback (humano necessario) | Sistema interno | <5% |
| Posts Instagram/semana | Instagram Insights | 16 feed + 25 stories |

---

## Proximos Passos Imediatos

1. **HOJE:** Corrigir compliance do BotConversa, CNPJ, links quebrados, CTAs mortos — Faixa 1 (#1-6)
2. **ESTA SEMANA:** Fotos reais, Augusto no site, precos na landing, iniciar conteudo — Faixa 2 (#7-12)
3. **PROXIMO:** Implementar agente AI baseado nos docs de design v3 FINAL — Faixa 3 (#13-21)
4. **PARALELO:** Mudar senha do admin como paliativo. Planejar reconstrucao de seguranca — Faixa 4

---

## Documentos de Referencia (v3 FINAL)

| Doc | Conteudo |
|-----|----------|
| `06-ai-consultation-design.md` (v3) | Identidade, fases (0-5), logica de produtos, regras de preco, antiban, ebook, webhooks, upsell, fallback |
| `07-compliance-guardrails.md` (v2) | Regras absolutas, linguagem por fase, regras de preco, guardrails tecnicos |
| `08-fallback-escalation.md` | Fallback interno invisivel. Substituiu handoff-rules. |
| `09-webhook-followup-playbook.md` (v2) | 5 webhooks, fluxos por evento, cadeia de upsell, metricas |
| `10-stress-test-simulations.md` | 15 simulacoes, 6 perfis, analise de drop-off, recomendacoes |

---

*Documento v4 FINAL. Agente e o especialista. Sem closer. Sem handoff.*
*Fases 1 + 2 — Diagnostico, Planejamento e Design da CredPositivo.*
