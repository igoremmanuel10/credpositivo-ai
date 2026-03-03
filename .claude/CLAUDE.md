# CredPositivo Agent — Claude Code Instructions

## Repo
- Local: `/tmp/credpositivo-ai/`
- Remote: `github.com/igoremmanuel10/credpositivo-ai` (branch: main)
- Server: `root@159.223.141.100:/opt/credpositivo-agent/`

## MCPs Disponíveis
- **postgres** — Query direta no DB (credpositivo_agent)
- **github** — Commits, PRs, issues no GitHub
- **docker** — Gerenciar containers no servidor
- **ssh-manager** — 37 tools: deploy, backup, monitoring, DB ops
- **fetch** — Buscar URLs
- **context7** — Docs de libs
- **sequential-thinking** — Raciocínio complexo

## Fluxo de Deploy (OBRIGATÓRIO)
1. Editar arquivos em `/tmp/credpositivo-ai/`
2. `git add` + `git commit` + `git push origin main`
3. SSH no servidor: `cd /opt/credpositivo-agent && git pull origin main`
4. Rebuild: `docker compose up -d --build agent`
5. Verificar: `docker logs credpositivo-agent-agent-1 --tail 20`

**NUNCA** editar via `docker cp`. Sempre pelo git.

## SSH Access
- Expect scripts: `/tmp/ssh_cmd.sh`, `/tmp/scp_upload.sh`, `/tmp/scp_download.sh`
- Ou via SSH MCP (ssh-manager)

## Arquivos Críticos
- `src/ai/system-prompt.js` — Prompt do Augusto (SDR)
- `src/ai/output-filter.js` — Compliance + cleanForWhatsApp
- `src/conversation/manager.js` — Pipeline de mensagens (split, validate, send)
- `src/quepasa/client.js` — Envio via WhatsApp (Quepasa)
- `src/ai/claude.js` — Integração com Claude API

## Regras
- Comunicar em português BR
- Owner = "Musk" (CEO)
- Framework Hormozi pra vendas
- Emojis PROIBIDOS no output do Augusto
- Max 120 chars por bolha no WhatsApp
