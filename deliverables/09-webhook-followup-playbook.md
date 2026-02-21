# Playbook de Follow-up Baseado em Webhooks (v2 FINAL)

**Fase 2 -- Design da Experiencia de Consulta**
**Data:** 13 de fevereiro de 2026
**Versao:** v2 — Agente e o especialista. Sem handoff. Upsell direto pelo agente.

---

## Conceito

O agente AI reage a eventos do dashboard (webhooks) para retomar contato no momento certo, com a mensagem certa. Ele e o MESMO atendente — nunca reinicia conversa como se fosse nova pessoa.

**Principio:** Follow-up e continuacao da consulta. O agente ja conhece o usuario e retoma com contexto. Nunca encerra. Nunca abandona lead.

---

## Eventos de Webhook

### Evento 1: `signup_completed`
**Disparo:** Usuario criou conta no site.
**Significado:** Deu o primeiro passo mas ainda nao comprou.
**Objetivo do agente:** Incentivar primeira compra.

### Evento 2: `purchase_completed`
**Disparo:** Usuario comprou produto no site (diagnostico, limpa nome ou rating).
**Significado:** Converteu. Agora precisa de acompanhamento + upsell.
**Objetivo do agente:** Confirmar, acompanhar, educar sobre proximos servicos.

### Evento 3: `purchase_abandoned`
**Disparo:** Usuario iniciou checkout mas nao finalizou.
**Significado:** Interesse alto, mas algo travou.
**Objetivo do agente:** Retomar interesse sem pressao.

### Evento 4: `consultation_timeout`
**Disparo:** Usuario parou de responder durante a conversa (24h sem resposta).
**Significado:** Esfriou, se distraiu, ou precisa de mais tempo.
**Objetivo do agente:** Retomar conversa. NUNCA encerrar.

### Evento 5: `link_sent_no_action`
**Disparo:** Agente enviou link do site mas usuario nao fez signup em 24h.
**Significado:** Nao se convenceu o suficiente, ou nao foi o momento.
**Objetivo do agente:** Lembrar e oferecer ajuda.

---

## Fluxos de Follow-up por Evento

---

### FLUXO 1: signup_completed (sem compra)

**Imediato (0-5 min apos evento):**
```
AGENTE:
[nome]! Vi que voce criou sua conta. Otimo primeiro passo!

Lembra que conversamos sobre [bloqueador principal]?
O [produto recomendado] e justamente o que confirma isso
e te da o mapa completo de acao.

No site voce ve os detalhes pra iniciar.
Qualquer duvida, to aqui.
```

**+24h (se nao comprou):**
```
AGENTE:
[nome], so passando pra ver se ficou alguma duvida.

Lembra do que conversamos sobre [bloqueador]?
O [produto] confirma exatamente isso e te mostra
o caminho completo.

To aqui se precisar.
```

**+72h (se nao comprou):**
```
AGENTE:
[nome], sei que essa decisao leva tempo e respeito isso.

Quando voce se sentir pronto(a), o site ta la.
E se quiser conversar mais, e so me chamar aqui.
```

**+7 dias (se nao comprou e nao respondeu):**
```
AGENTE:
[nome], so passando pra lembrar que to aqui se precisar.
Seu caso ta mapeado, e so retomar quando quiser.
```

---

### FLUXO 2: purchase_completed

#### Comprou DIAGNOSTICO

**Imediato:**
```
AGENTE:
[nome], perfeito! Seu diagnostico ta ativo.
Vou acompanhar de perto. Assim que o resultado sair,
te aviso e te explico tudo o que aparecer.

Parabens por dar esse passo!
```

**Apos resultado (triggered by `diagnosis_completed`):**
```
AGENTE:
[nome], seu diagnostico ficou pronto!

Com base nos resultados, vou te explicar o que
encontramos e quais sao os proximos passos possiveis.

[explicacao personalizada com base no resultado]

Dependendo do seu caso, as acoes possiveis sao:
- Regularizacao cadastral (limpa nome) — remove restricoes
  e te da acesso a cartao de credito parceiro
- Reconstrucao do perfil bancario (rating) — trabalha os
  fatores internos que os bancos analisam

No site voce ve os detalhes de cada um:
[LINK]

Qualquer duvida, to aqui.
```

**+24h apos resultado (se nao comprou proximo servico):**
```
AGENTE:
[nome], so passando pra ver se ficou alguma duvida
sobre o resultado do diagnostico.

Se quiser entender melhor algum ponto ou saber mais
sobre os proximos passos, to aqui.
```

#### Comprou LIMPA NOME

**Imediato:**
```
AGENTE:
[nome], otimo! Seu processo de limpa nome ta ativo.
Vou te acompanhar.

Quando concluir, alem de nome limpo, voce ganha
acesso ao cartao de credito parceiro.
```

**Apos conclusao do limpa nome:**
```
AGENTE:
[nome], seu processo de limpa nome foi concluido!

Agora voce tem acesso ao cartao de credito parceiro.
No site voce ativa:
[LINK]

E sobre os proximos passos: dependendo do resultado,
a reconstrucao do perfil bancario (rating) pode ser
o que falta pra voce realmente conseguir credito.

Quer que eu te explique como funciona?
```

#### Comprou RATING

**Imediato:**
```
AGENTE:
[nome], excelente! Seu processo de rating ta ativo.
O diagnostico ja ta incluso, entao vamos ter o raio-x
completo do seu perfil.

Vou te acompanhar em cada etapa. Qualquer duvida, to aqui.
```

**Apos etapas de progresso:**
```
AGENTE:
[nome], atualizacao sobre seu rating:
[progresso ou resultado parcial]

To acompanhando. Qualquer duvida, me chama.
```

---

### FLUXO 3: purchase_abandoned

**+30 min apos abandono:**
```
AGENTE:
[nome], vi que voce comecou mas nao finalizou.
Sem problema!

Se ficou alguma duvida, posso te explicar.
Lembra que conversamos sobre [bloqueador]?
O [produto] confirma exatamente isso.
```

**+24h (se nao respondeu):**
```
AGENTE:
[nome], lembra do que conversamos sobre [bloqueador]?

O [produto] e o proximo passo pra confirmar e montar
o plano de acao.

Se o momento nao e agora, tudo bem. Mas se ficou
alguma duvida, to aqui.
```

**+72h (se nao respondeu):**
```
AGENTE:
[nome], sem querer insistir. So queria ter certeza
de que voce viu tudo no site:

[LINK]

Quando fizer sentido, ta la.
To aqui pra qualquer duvida.
```

---

### FLUXO 4: consultation_timeout (parou de responder)

**+24h apos ultima mensagem:**
```
AGENTE:
[nome]! A gente tava conversando sobre sua situacao
de credito. Parece que voce precisou sair.

Sem problema! Quando quiser retomar, to aqui.
Ja tenho o contexto de tudo que conversamos.
```

**+72h (se nao respondeu):**
```
AGENTE:
[nome], lembro que voce mencionou [bloqueador especifico].
Isso provavelmente ta impactando [consequencia].
Quando quiser, te explico melhor.

Nosso Instagram tambem tem conteudo util: @credpositivo
```

**+7 dias (se nao respondeu):**
```
AGENTE:
[nome], so passando pra lembrar que to aqui
se precisar de orientacao sobre seu credito.
Seu caso ta mapeado, e so retomar quando quiser.
```

**Regra:** O agente NUNCA encerra. Vai espacando (24h → 72h → 7d → semanal) mas nunca para completamente.

---

### FLUXO 5: link_sent_no_action (link enviado, sem signup)

**+24h apos envio do link:**
```
AGENTE:
[nome], ontem te mandei o link do site.
Conseguiu dar uma olhada?

Se ficou alguma duvida, posso te ajudar.
```

**+72h (se nao respondeu):**
```
AGENTE:
[nome], o link ta aqui se precisar:

[LINK]

Quando fizer sentido pra voce, ta la.
To aqui se quiser conversar mais.
```

**+7 dias (se nao respondeu):**
```
AGENTE:
[nome], to aqui se precisar. Quando quiser
retomar, e so me chamar.
```

---

## Regras Gerais de Follow-up

### Frequencia
- Maximo 1 mensagem por dia ao mesmo usuario
- Maximo 3 tentativas por fluxo de webhook ativo
- Apos 3 tentativas sem resposta: espacar para semanal
- Se o usuario pediu para parar, parar IMEDIATAMENTE e registrar
- O agente NUNCA encerra definitivamente

### Tom
- Follow-up e continuacao de conversa, nao cobranca
- Sempre referenciar algo especifico da conversa anterior (bloqueador, situacao)
- Nunca usar urgencia artificial
- Nunca mencionar preco no follow-up
- Sempre dar opcao de saida ("quando fizer sentido", "sem pressao")
- Follow-up de timeout deve incluir micro-insight personalizado

### Prioridade de Webhooks
Se multiplos eventos acontecem ao mesmo tempo:

1. `purchase_completed` (maior prioridade — confirmar + upsell)
2. `purchase_abandoned` (lead quente, retomar)
3. `signup_completed` (incentivar compra)
4. `link_sent_no_action` (lembrar)
5. `consultation_timeout` (retomar)

### Cancelamento de Fluxo
- Se o usuario responde a qualquer follow-up, o fluxo automatico PARA e o agente retoma conversa ao vivo
- Se um webhook de prioridade maior chega, o fluxo anterior e cancelado
- Se o usuario comprou (`purchase_completed`), TODOS os fluxos de venda sao cancelados e entra fluxo de upsell
- Se o usuario pediu pra parar, TODOS os fluxos sao cancelados

---

## Cadeia de Upsell

O agente acompanha o lead ao longo de TODA a jornada de compra:

```
Conversa → Diagnostico → Limpa Nome → Rating → Proximos servicos
```

Cada `purchase_completed` e uma oportunidade de educar sobre o proximo passo:

| Comprou | Proximo passo educativo |
|---------|------------------------|
| Diagnostico | Explicar resultados + recomendar limpa nome ou rating |
| Limpa nome | Celebrar + ativar cartao parceiro + recomendar rating |
| Rating | Acompanhar progresso + orientar sobre proximos servicos |

**Regra:** Upsell e SEMPRE educativo. "Dependendo do resultado, o proximo passo pode ser..." Nunca empurrar.

---

## Mapa Visual dos Fluxos

```
CONVERSA ATIVA (Fases 0-4)
    |
    +-- Usuario responde → continua conversa
    |
    +-- Timeout 24h → FLUXO 4 (consultation_timeout)
    |       |
    |       +-- Retoma → conversa continua
    |       +-- Nao retoma → espaca (72h, 7d, semanal)
    |
    +-- Link enviado (Fase 4) → usuario sai
            |
            +-- Nenhuma acao 24h → FLUXO 5 (link_sent_no_action)
            |
            +-- Signup → FLUXO 1 (signup_completed)
            |       |
            |       +-- Comprou → FLUXO 2 (purchase_completed)
            |       |       |
            |       |       +-- Diagnostico → resultado → upsell limpa/rating
            |       |       +-- Limpa nome → conclusao → upsell rating
            |       |       +-- Rating → acompanhamento → proximos servicos
            |       |
            |       +-- Nao comprou → follow-up (24h, 72h, 7d)
            |       |
            |       +-- Checkout abandonado → FLUXO 3 (purchase_abandoned)
            |
            +-- Nenhuma acao → FLUXO 5 continua
```

**Diferenca fundamental v2:** Nao existe mais "handoff para closer" em nenhum ponto do fluxo. O agente e o unico responsavel.

---

## Metricas de Follow-up

| Metrica | Meta |
|---------|------|
| Taxa de resposta ao follow-up (qualquer fluxo) | > 30% |
| Taxa de recuperacao de abandoned checkout | > 15% |
| Taxa de conversao signup → purchase (com follow-up) | > 25% |
| Tempo medio entre link enviado e signup | < 48h |
| Taxa de upsell pos-diagnostico (limpa nome ou rating) | > 20% |
| Taxa de upsell pos-limpa nome (rating) | > 15% |
| Leads que pediram para parar | < 5% |

---

*Documento v2 FINAL. Agente e o especialista. Sem handoff. Upsell direto.*
*Fase 2 — Design Comportamental da CredPositivo.*
