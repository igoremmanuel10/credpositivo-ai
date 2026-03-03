---
name: credpositivo-deploy
description: Deploy changes to the CredPositivo production server. Use when the user says "deploy", "push to production", "update server", "rebuild", or after making code changes that need to go live. Handles git commit, push, server pull, docker rebuild, and verification.
---

# CredPositivo Deploy Skill

## When to Use
- After editing source files in `/tmp/credpositivo-ai/`
- When user says "deploy", "push", "update server", "rebuild"
- After fixing bugs or updating prompts

## Deploy Flow

### Step 1: Commit Changes Locally
```bash
cd /tmp/credpositivo-ai
git add <changed-files>
git commit -m "<descriptive message>"
git push origin main
```

### Step 2: Pull on Server
Via SSH (expect script or SSH MCP):
```bash
ssh root@159.223.141.100 "cd /opt/credpositivo-agent && git pull origin main"
```

### Step 3: Rebuild Container
```bash
ssh root@159.223.141.100 "cd /opt/credpositivo-agent && docker compose up -d --build agent"
```

### Step 4: Verify
```bash
ssh root@159.223.141.100 "docker logs credpositivo-agent-agent-1 --tail 20"
```
Check for startup errors. If clean, deploy is complete.

## Server Details
- Host: 159.223.141.100
- User: root
- App path: /opt/credpositivo-agent
- Container: credpositivo-agent-agent-1
- Repo: github.com/igoremmanuel10/credpositivo-ai

## Safety Rules
- NEVER deploy without committing first
- ALWAYS verify container starts clean after rebuild
- If build fails, check `docker logs` and fix before retrying
- Keep commits atomic (one fix per commit)

## Rollback
If something breaks after deploy:
```bash
ssh root@159.223.141.100 "cd /opt/credpositivo-agent && git revert HEAD && docker compose up -d --build agent"
```
