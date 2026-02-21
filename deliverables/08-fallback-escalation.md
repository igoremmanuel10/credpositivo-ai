# Fallback Interno e Escalation -- Agente AI CredPositivo

**Fase 2 -- Design da Experiencia de Consulta**
**Data:** 13 de fevereiro de 2026
**Versao:** Substituiu `08-handoff-rules.md`. Nao existe mais handoff para closer.

---

## Conceito

O agente AI e o unico ponto de contato do usuario. Nao existe transferencia visivel para humano.

Em casos extremos, um humano pode assumir o controle da conversa **sem que o usuario saiba**. A mensagem continua vindo "do Augusto". O usuario nunca percebe a troca.

**Principio:** O agente e o especialista. Se ele precisa de ajuda, e um problema interno, nao do usuario.

---

## Quando o Fallback Interno e Ativado

### Gatilhos Automaticos

| Gatilho | Descricao | Urgencia |
|---------|-----------|----------|
| **Mencao de suicidio ou autolesao** | Usuario expressa ideacao suicida ou risco | CRITICA — humano assume imediatamente |
| **Ameaca legal contra a empresa** | "Vou processar voces" / "Meu advogado vai entrar em contato" | ALTA — humano avalia e responde |
| **Bug do sistema** | Agente nao consegue processar, loop, erro repetido | ALTA — humano corrige e retoma |
| **Pergunta fora do escopo total** | Assunto que nao tem nada a ver com credito/financeiro | BAIXA — agente tenta redirecionar; se falha, flag |

### Gatilhos Manuais (equipe interna)

| Gatilho | Descricao |
|---------|-----------|
| **Override manual** | Equipe interna decide assumir conversa especifica |
| **Lead VIP** | Lead identificado como alto valor por outro canal |
| **Reclamacao em outro canal** | Usuario reclamou no Instagram/Reclame Aqui e precisa de atencao especial |

---

## Como Funciona o Fallback

1. **Flag interno** e disparado (automatico ou manual)
2. **Humano recebe notificacao** com contexto completo da conversa
3. **Humano assume o WhatsApp** do "Augusto" — mesma thread, mesmo nome
4. **Usuario NAO percebe** a troca
5. **Humano responde como Augusto** seguindo as mesmas regras de compliance
6. **Quando resolvido**, humano devolve controle ao agente AI

---

## Contexto Entregue ao Humano

Quando o fallback e ativado, o humano recebe:

```
=== FALLBACK INTERNO ===

MOTIVO: [gatilho que ativou]
URGENCIA: [critica / alta / baixa]
DATA/HORA: [timestamp]

--- CONTEXTO DA CONVERSA ---
Nome: [nome do usuario]
WhatsApp: [numero]
Fase atual: [0-5]
Mensagens trocadas: [quantidade]

--- SITUACAO MAPEADA ---
[Resumo automatico do que o agente coletou]

--- ULTIMAS 5 MENSAGENS ---
[Ultimas 5 mensagens da conversa]

--- RECOMENDACAO DO AGENTE ---
[O que o agente estava tentando fazer quando o fallback foi ativado]

=== FIM ===
```

---

## Regras para o Humano no Fallback

### O humano DEVE:
- Ler o contexto completo antes de responder
- Responder COMO AUGUSTO (mesmo tom, mesmo estilo)
- Seguir todas as regras de compliance do agente
- Manter mensagens curtas (estilo WhatsApp)
- Resolver a situacao e devolver ao agente

### O humano NUNCA:
- Se identifica como humano ou como "outra pessoa"
- Muda o tom da conversa
- Contradiz o que o agente disse anteriormente
- Menciona preco em reais
- Promete resultado
- Faz handoff para outro humano visivel ao usuario

---

## Metricas de Fallback

| Metrica | Meta |
|---------|------|
| % de conversas que ativam fallback | < 5% |
| Tempo de resposta do humano apos flag | < 10 min (horario comercial) |
| Resolucao sem que usuario perceba troca | 100% |
| Retorno ao agente AI apos fallback | > 90% |

---

## Nota sobre o Antigo Handoff

O documento anterior (`08-handoff-rules.md`) definia handoff para "closer humano" como parte normal do fluxo. Isso foi **removido completamente**.

Resumo das mudancas:
- ~~Handoff padrao apos consulta~~ → Agente acompanha ate conversao
- ~~Handoff por insistencia em preco~~ → Agente segue regra 1x/2x/3x
- ~~Handoff por "quero falar com humano"~~ → Agente continua como especialista
- ~~Closer recebe resumo~~ → Agente e o proprio closer
- ~~Template de resumo para closer~~ → Substituido por contexto de fallback interno

O usuario nunca sabe que existe alguem alem do Augusto.

---

*Documento substituiu 08-handoff-rules.md.*
*Fase 2 — Design Comportamental da CredPositivo.*
