# CredPositivo - Project Details

## Serviços (3 produtos)

### 1. Diagnóstico de Rating Bancário — R$67
- Raio X do CPF: identifica dívidas, rating, por que banco nega
- Resultado: instantâneo
- Checkout: Monetizze (app.monetizze.com.br/checkout/DLF374307)
- Link profissional: credpositivo.com/diagnostico (redirect nginx → Monetizze)
- Porta de entrada padrão — TODOS os leads passam pelo diagnóstico

### 2. Limpa Nome — R$497
- Tira seu nome do SPC, Serasa e outros birôs de crédito
- Também cobre Boa Vista e Cenprot (Central de Protestos)
- CPF ou CNPJ
- Base legal: direito garantido por lei a consumidores não notificados pessoalmente por AR pelos órgãos de proteção ao crédito
- Prazo: média de 15 dias úteis

### 3. Rating — R$997
- Construção de rating bancário pra conseguir linha de crédito
- Prazo do serviço: 20 dias úteis
- Prazo do aumento de crédito efetivo: 2 a 6 meses → SÓ FALAR SE O LEAD PERGUNTAR DIRETAMENTE

Site: credpositivo.com/diagnostico (conversion point → Monetizze)
LTV máximo por lead: R$67 + R$497 + R$997 = R$1.561

## Roteamento
- Caminho padrão: TODOS → Diagnóstico (R$67) primeiro
- Se lead já quer Limpa Nome ou Rating direto → Paulo fecha, diagnóstico incluído no serviço
- Pós-diagnóstico → upsell baseado no resultado (Limpa Nome ou Rating)

## Papéis dos Agentes (Hormozi Framework)
- **Augusto (SDR)** = Qualifica leads (dor + capacidade + decisão + urgência). Roteia pro produto certo. Fecha diagnóstico no chat. Encaminha leads qualificados pro Paulo pra tickets maiores.
- **Paulo (Closer)** = Fecha Limpa Nome (R$497) e Rating (R$997). Usa ligação VAPI + WhatsApp. Trata objeções. Toda conversa termina com pagamento ou follow-up agendado.
- **Ana (Ops)** = Pipeline e CRM. Garante que todo lead tem status, responsável, próxima ação, data. Sinaliza leads parados.
- **Luan (Manager)** = Analisa pipeline, identifica gargalos, otimiza conversão e receita. Gera relatórios de performance com recomendações acionáveis. Usa Claude AI para interpretação estratégica.
- **Alex (DevOps/SRE)** = Agente autônomo de monitoramento. Health check a cada 10min, auto-fix de locks/conversas travadas, AI diagnosis de erros, alerta crítico via WhatsApp, relatório diário 23h BRT. Comando: `#alex` ou `#devops`.
- **VAPI** = Ligações automatizadas. Usado como follow-up do Augusto (24h) e como ferramenta de fechamento do Paulo.

## Bugs Conhecidos
- Augusto e Paulo mandaram msgs para contatos pessoais do dono, não leads reais. Investigar filtro de destinatários.

## Architecture
- Server: DigitalOcean, root@159.223.141.100, password: 100159
- Host: ubuntu-s-2vcpu-4gb-nyc1-01
- Portainer: http://159.223.141.100:9000
- Local clone: /tmp/credpositivo-ai/
- Server path: /opt/credpositivo-agent/
- Deploy: sshpass + scp direto (sem git no servidor)
- DB: PostgreSQL (credpositivo_agent) via Docker
- Redis: Docker (credpositivo-agent-redis-1)
- Chatwoot: chat.credpositivo.com (Admin API token: 1zNtbaX9mvsjMLrSYZRbzCZL, port 3000)
- Chatwoot inbox "Operações": ID=3 (tipo API, para relatórios internos)

## MCPs Configurados (settings.json)
- **postgres** — Query direta no DB
- **github** — Git ops (commits, PRs, issues)
- **docker** — Container management via SSH
- **ssh-manager** — SSH com credenciais salvas
- **fetch** — Web requests
- **context7** — Docs de libs
- **sequential-thinking** — Raciocínio complexo
- **quepasa** — WhatsApp API direta
- **redis** — Redis do servidor (159.223.141.100:6379)
- **docker-logs** — Logs dos containers via SSH
- **playwright** — Automação de browser (testes E2E)
- **chrome-devtools** — Debug de frontend no browser

## Skills Instaladas (.claude/skills/)
- **skill-creator** — Criar skills customizadas
- **credpositivo-deploy** — Fluxo de deploy padronizado

## Key Files (local paths em /tmp/credpositivo-ai/)
- **State machine**: src/flow/machine.js (transições, qualificação, intent detection)
- **Media rules**: src/flow/media-rules.js (edu staging, prova social, payment links, nudges)
- **Conversation manager**: src/conversation/manager.js (pipeline 10 passos, state machine antes do LLM)
- **Followup/Nudges**: src/conversation/followup.js (cron 5min + processNudges)
- **Stress tests**: tests/stress-test.js (106 assertions)
- Prompts: src/ai/prompts/ (core, footer, phase-0-1, phase-2, phase-3, phase-4, objections)
- SDR prompt: src/ai/sdr-prompt.js
- Claude integration: src/ai/claude.js
- Output filter: src/ai/output-filter.js
- Quepasa client: src/quepasa/client.js (WhatsApp send)
- Redis cache: src/db/redis.js (getNudgeKeys, daily counters)
- Alex devops: src/devops/alex.js
- Jobs orchestrator: src/orchestrator/igor.js

## Current State (05/mar/2026)
- Source em `/root/credpositivo-ai/src/` — build com `docker compose build agent`
- Deploy: `cd /root/credpositivo-ai && docker compose up -d agent`
- **PATCHES NO HOST, NAO NO CONTAINER** — docker cp nao persiste entre restarts
- QA Auto-Corrector ATIVADO (cada 5min, Redis boosters, auto-fix prompt)
- Credit Check: pf-dadosbasicos (R$0.40) + ap-boavista (SCPC) para fase 3+
- Boa Vista: score, pendencias, protestos, renda presumida
- Boosters: system-prompt.js le `qa:prompt_boosters` do Redis antes de cada call
- 5 prova social videos + 5 audios novos + infograficos + videos tutorial — todos no disco
- Team meeting weekly (Monday 7h BRT)

## Bugs Corrigidos (05/mar)
- R$97→R$67 no sdr-prompt.js (Paulo)
- "Nao precisa mandar CPF" removido do sdr-prompt.js
- siteUrl com aspas simples → backticks (manager.js:924)
- Prova social hardcoded 'augusto' → usa persona ativa
- 30s blocking await → fire-and-forget

## Gaps Conhecidos (ver /tmp/credpositivo-deploy/ROTINA-DIARIA-AGENTES.md)
- Phase 3→4 conversao 7.3% (meta: 35%)
- Credit check coverage 5.2% (meta: 60%)
- 692 follow-ups atrasados
- 96 leads parados >48h
- Hormozi framework ~20% implementado no prompt
- 8 objecoes nao cobertas
- Audios orfaos (followup_3d, pos_compra) nao wired no fluxo
- Follow-up pos-compra (Phase 5 upsell) nao existe

## User Preferences
- Owner goes by "agente: musk"
- Wants expert-level sales analysis (Hormozi framework)
- Prefers decisive recommendations over questions
- Communication in Portuguese (BR)
