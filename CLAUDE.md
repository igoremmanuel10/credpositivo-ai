# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**credpositivo-ai** — Platform for CredPositivo, a Brazilian credit analysis service. Helps people with negative credit status achieve credit approval through banking profile analysis and strategic corrections.

## Business Context

- Mission: "Do nome sujo ao crédito aprovado" — diagnosis + plan + optional execution
- Products: Diagnóstico (R$97), Limpa Nome (R$600), Reconstrução de Perfil Bancário/Rating (R$1200, includes diagnosis)
- Limpa Nome benefit: user gets access to partner credit card after completion
- Rating benefit: includes full diagnosis
- ICP: Brazilian adults with low score, negative name, or denied credit
- Compliance: NEVER promise credit approval or score increase. NEVER invent data.

## Funnel (v3 FINAL)

```
Instagram → Bio → WhatsApp (AI Agent = specialist) → Site (purchase) → AI Agent (follow-up + upsell)
```

- **AI Agent "Augusto"** (WhatsApp): IS the specialist. Conducts full journey: investigate → educate → recommend product → send to site → follow-up → upsell. No handoff to human. No closer.
- **Site**: Where ALL purchases happen. Agent never closes sale in WhatsApp.
- **Human**: Internal fallback only. Invisible to user. Takes over as "Augusto" in extreme cases.
- **Webhooks**: `signup_completed`, `purchase_completed`, `purchase_abandoned`, `consultation_timeout`, `link_sent_no_action`

### Agent Key Rules
- Antiban block before every conversation (save contact)
- Price: 1x = conceptual answer, 2x = send site link, 3x = push to site now
- Product logic: negativado → diagnosis → limpa nome → rating. Nome limpo → rating (includes diagnosis).
- Never transfers to human. Never mentions "specialist" or "closer".
- Never ends conversation. Spaces out follow-ups but never stops.
- Ebook (free PDF) offered between investigation and education phases.

## System Pages

- `/bio` — Link-in-bio hub (main Instagram entry point)
- `/` — Landing page (Score vs Rating comparison)
- `/cadastro` — User signup (broken — localStorage-based)
- `/login` — User login (broken — dashboard 404)
- `/adm` — Admin panel (hardcoded credentials — critical security issue)

## Deliverables

### Phase 1 (diagnosis & audit)
- `deliverables/01-system-funnel-audit.md` — System and funnel audit
- `deliverables/02-ui-brand-audit.md` — UI/brand audit + mini design system
- `deliverables/03-content-plan-7days.md` — 7-day Instagram content plan (41 pieces/week)
- `deliverables/04-whatsapp-playbook.md` — WhatsApp playbook + phone scripts (legacy reference)
- `deliverables/05-prioritized-actions.md` — **v4 FINAL**: 27 actions in 4 tiers, no closer, agent is specialist

### Phase 2 (AI consultation design — v3 FINAL)
- `deliverables/06-ai-consultation-design.md` (v3) — Agent identity, phases 0-5, product logic, price rules, antiban, ebook, webhooks, upsell, fallback
- `deliverables/07-compliance-guardrails.md` (v2) — Absolute rules, language per phase, price compliance, product compliance, technical guardrails
- `deliverables/08-fallback-escalation.md` — Internal fallback (replaced handoff-rules). Human assumes invisibly.
- `deliverables/09-webhook-followup-playbook.md` (v2) — 5 webhooks, follow-up flows, upsell chain, metrics
- `deliverables/10-stress-test-simulations.md` — 15 simulated conversations, 6 profiles, drop-off analysis, 12 recommendations

## AI Agents (Claude Code)

### Augusto — Agente WhatsApp (Runtime)
- Atendente de crédito que conversa com leads via WhatsApp
- Stack: Node.js + OpenAI GPT-4o-mini + Quepasa + Chatwoot + PostgreSQL + Redis
- Roda em Docker no servidor 159.223.141.100

### Ana — Social Media & Conteúdo
- `.claude/agents/ana.md`
- Revisa mensagens do Augusto, cria conteúdo, define tom de voz

### Fernando Dev — Desenvolvedor Senior Autônomo
- `.claude/agents/fernando-dev.md`
- Manutenção contínua, diagnóstico de erros, correção de bugs, monitoramento
- Responsável por estabilidade do sistema inteiro (servidor, containers, integrações)
- Prioridade: estabilidade > features novas
- Nunca altera estrutura do servidor, apenas adapta código

## Server (Production)

- **IP:** 159.223.141.100 (DigitalOcean)
- **SSH:** `ssh root@159.223.141.100`
- **Portainer:** http://159.223.141.100:9000
- **Agent code:** `/opt/credpositivo-agent/`
- **Website:** `/var/www/html/`
- **Containers:** postgres, redis, quepasa, chatwoot-web, chatwoot-worker, agent

## Agent MVP (Phase 3)

Located at `/opt/credpositivo-agent/` (server). Stack: Node.js + OpenAI + Quepasa + Chatwoot + PostgreSQL + Redis + Docker.

### Key files (server paths)
- `src/ai/system-prompt.js` — Behavioral spec do Augusto (identity, phases, products, compliance)
- `src/ai/output-filter.js` — Compliance filter (banned keywords)
- `src/ai/claude.js` — OpenAI client (GPT-4o-mini)
- `src/conversation/manager.js` — Core orchestration (debounce → AI → filter → send → save)
- `src/conversation/followup.js` — Cron follow-up scheduler (DESATIVADO)
- `src/quepasa/client.js` — Quepasa WhatsApp client (sendText, sendMessages)
- `src/chatwoot/client.js` — Chatwoot client (contacts, conversations, messages)
- `src/evolution/webhook.js` — Webhook receiver (Quepasa + Chatwoot)
- `src/audio/transcribe.js` — Audio transcription
- `src/db/migrations/` — SQL schema (001_init, 002_delivery_tracking, 003_add_opted_out)

### Running (server)
```
ssh root@159.223.141.100
cd /opt/credpositivo-agent && docker compose up -d    # All services
docker compose restart agent                           # Restart agent only
docker compose up -d --build agent                     # Rebuild + restart agent
docker logs credpositivo-agent-agent-1 --tail 200      # View agent logs
```

## Critical Findings (still open)

- Admin credentials hardcoded in source code (visible via DevTools) — Faixa 4
- Passwords stored in plain text in localStorage — LGPD violation — Faixa 4
- ~~CNPJ placeholder (00.000.000/0001-00) in terms of use~~ — FIXED (removed)
- ~~Landing page CTA buttons link to "#" (nowhere)~~ — FIXED (→ WhatsApp)
- Dashboard returns 404 — Faixa 4
- BotConversa promises "Aumentamos seu Score" — being replaced by AI agent

## Website Source

Located at `/Users/igoremmanuel/Downloads/CredPositivo/`. Plain HTML/CSS/JS.

## Status

Phase 3 (implementation) in progress. Faixa 1 emergency fixes applied to website. Agent MVP scaffolded with full system prompt, Evolution API integration, conversation state machine, compliance filter, and follow-up scheduler. Next: deploy Docker stack, connect WhatsApp, test end-to-end.
