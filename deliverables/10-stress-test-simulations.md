# Stress Test: 15 Simulacoes de Conversa com o Agente AI

**Fase 2 -- Validacao do Design**
**Data:** 13 de fevereiro de 2026

---

## Metodologia

15 conversas simuladas com 6 perfis de lead diferentes. Cada conversa segue o design de `06-ai-consultation-design.md` e `07-compliance-guardrails.md`. Analise focada em:
- Momentos de abandono (drop-off)
- Pontos de confusao
- Quebras de confianca
- Onde o usuario pergunta preco
- Quando aceita ir ao site

**Perfis testados:**
- Divida urgente (3 conversas)
- Nome limpo mas negado (2 conversas)
- Renda alta sem credito (2 conversas)
- Usuario desconfiado (3 conversas)
- Sensivel a preco (3 conversas)
- Usuario silencioso (2 conversas)

---

## SIMULACAO 1: Divida Urgente — Precisa de financiamento em 30 dias

**Perfil:** Marcos, 34 anos. Nome negativado ha 2 anos. Precisa de financiamento para carro ate o mes que vem. Desesperado.

### Conversa

```
MARCOS: Boa tarde, preciso limpar meu nome urgente

AGENTE (Fase 1):
Oi, Marcos! Tudo bem?
Eu sou o Augusto, consultor de credito da CredPositivo.
Entendo que ta urgente. Quero te ajudar de verdade,
mas preciso entender sua situacao primeiro.
Me conta: o que ta acontecendo hoje?

MARCOS: To negativado faz 2 anos e preciso financiar um carro
ate o mes que vem pra trabalhar. Se nao consigo to ferrado.

AGENTE (Fase 2):
Puxa, imagino a pressao. Me ajuda a entender melhor:
Voce sabe quais dividas aparecem no seu CPF?

MARCOS: Tem uma do Bradesco de cartao e uma da Claro

AGENTE:
Entendi. E voce ja tentou negociar alguma dessas?

MARCOS: Ja, paguei a da Claro no feirão mas nada mudou.
O Serasa continua igual.

AGENTE:
Isso e mais comum do que parece. Pagar no feirao limpa a
divida, mas nem sempre muda o que o banco ve.
Voce tem conta em quais bancos hoje?

MARCOS: Bradesco e Nubank

AGENTE:
Ha quanto tempo? Movimenta com frequencia?

MARCOS: Bradesco faz uns 5 anos. Nubank abri ano passado.
Uso mais o Nubank.

AGENTE:
Ja teve cartao de credito antes?

MARCOS: Tinha no Bradesco, cancelaram quando negativei.

AGENTE (Ebook):
Marcos, antes de te explicar o que provavelmente ta
acontecendo, quero te mandar um material que a gente preparou.
E um guia sobre como funciona o mercado de credito no Brasil.
Posso te mandar?

MARCOS: Cara nao tenho tempo pra ler nada agora.
Preciso resolver isso logo.

AGENTE (segue sem insistir):
Sem problema. Vou direto ao ponto entao.

AGENTE (Fase 3):
Marcos, com base no que voce me contou, o que provavelmente
ta travando e uma combinacao de coisas:

1. A negativacao do Bradesco ainda ta ativa no CPF
2. Voce pagou a Claro no feirao, mas o registro no Bacen
   continua mostrando o historico -- e isso o banco ve
3. Voce perdeu o cartao do Bradesco, o que danificou seu
   perfil bancario naquele banco

Muita gente acha que pagar a divida resolve tudo.
Mas o banco nao consulta so o Serasa. Ele consulta o Bacen
e o SCR -- e la aparece tudo: historico de pagamento,
restritivos, relacionamento.

MARCOS: Entao paguei a Claro a toa?

AGENTE:
Nao a toa -- foi o certo a fazer. Mas e so o primeiro passo.
Tem acoes especificas pra reconstruir o que o banco ve.

Existem basicamente 3 coisas que podem ser feitas:

1. Diagnostico financeiro -- e um raio-x do seu CPF.
   Mostra tudo que os bancos veem, inclusive o que nao
   aparece nos apps. E o primeiro passo porque sem ele
   qualquer acao e no escuro.

2. Limpeza de nome -- remove negativacoes com base legal.
   Mas limpar o nome sozinho nem sempre resolve.

3. Reconstrucao do perfil bancario -- trabalha os fatores
   que os bancos realmente analisam.

No seu caso, o diagnostico confirma as hipoteses que
levantamos aqui e mostra exatamente o que fazer e em
que ordem.

MARCOS: Mas eu preciso do financiamento em 30 dias.
Isso resolve a tempo?

⚠️ PONTO CRITICO: O agente NAO pode prometer prazo.

AGENTE:
Marcos, vou ser honesto: nao consigo te prometer prazo
de aprovacao porque depende do que o diagnostico encontrar.

O que posso te dizer e que sem saber exatamente o que ta
no seu perfil, qualquer acao agora e no escuro. O diagnostico
te da essa clareza rapido.

MARCOS: Entendi. Quanto custa?

⚠️ PERGUNTA DE PRECO: Fase 3, antes do link.

AGENTE (Fase 4):
No site tem todas as informacoes de investimento. E acessivel.

Marcos, resumindo:
1. Negativacao ativa do Bradesco
2. Historico de inadimplencia no Bacen (mesmo apos pagar Claro)
3. Perfil bancario danificado (perda do cartao Bradesco)

O diagnostico confirma isso com dados reais.
O proximo passo e pelo site:

[LINK]

La voce cria sua conta, ve os detalhes e inicia quando quiser.

MARCOS: Vou ver.
```

**Resultado:** Lead recebeu link. Aceitou ir ao site na Fase 4 apos pergunta de preco.

**Observacoes:**
- ⚠️ Recusou ebook (pressa)
- ⚠️ Perguntou preco na Fase 3
- ⚠️ Perguntou sobre prazo — momento critico de confianca
- ✅ Aceitou a explicacao de "nao posso prometer"
- ✅ Aceitou o link

---

## SIMULACAO 2: Divida Urgente — Emocional e desesperado

**Perfil:** Fernanda, 28 anos. Perdeu emprego, dividas acumuladas, prestes a perder apartamento alugado. Muito emocional.

### Conversa

```
FERNANDA: por favor me ajudem eu to desesperada

AGENTE (Fase 1):
Oi, Fernanda! Eu sou o Augusto, consultor de credito
da CredPositivo.

Eu te ouco. Sei que essa situacao pesa muito.
Me conta o que ta acontecendo?

FERNANDA: perdi meu emprego 6 meses atras, nao consigo
pagar nada, meu nome ta sujo em tudo, nao consigo
nem alugar outro apartamento. to devendo aluguel e
vao me despejar

AGENTE (Fase 2):
Fernanda, primeiro: respira. Voce ta fazendo a coisa certa
buscando entender sua situacao.

Me ajuda com alguns pontos: voce sabe quais dividas
aparecem no seu CPF hoje?

FERNANDA: nao sei nem quantas sao. sei que tem cartao,
emprestimo e acho que aluguel tbm

AGENTE:
Entendi. E voce ja tentou negociar alguma coisa?

FERNANDA: nao tenho dinheiro pra negociar nada

AGENTE:
Faz sentido. Voce tem conta em algum banco?

FERNANDA: tinha no Itau mas acho que cancelaram

AGENTE:
E ta trabalhando hoje ou buscando emprego?

FERNANDA: to fazendo bico mas nao da pra nada

⚠️ PONTO CRITICO: Lead sem renda. Diagnostico custa R$97.
O agente precisa continuar educando sem empurrar compra.

AGENTE:
Fernanda, entendo. Muita gente passa por isso e
nao e culpa sua. O mercado de credito no Brasil
e complexo demais.

Deixa eu te mandar um material que pode te ajudar
a entender melhor seus direitos e como funciona.
E gratuito. Posso te mandar?

FERNANDA: pode sim

AGENTE:
Aqui ta o guia:
[ENVIAR PDF]

Da uma olhada quando puder. Agora deixa eu te explicar
o que provavelmente ta acontecendo no seu caso.

AGENTE (Fase 3):
Fernanda, pelo que voce me contou:

1. Voce tem multiplas negativacoes ativas
2. Sua conta no Itau pode ter sido encerrada, o que
   danifica seu perfil bancario
3. Sem renda formal, fica mais dificil pra qualquer
   banco te aprovar

Mas tem coisas que muita gente nao sabe:
Depois de 5 anos, a negativacao SAI do Serasa por lei.
E existem formas de limpar antes com base no CDC.

Existem acoes possiveis: diagnostico (raio-x do CPF),
limpeza de nome (base legal), e reconstrucao de perfil.
Mas tudo comeca com o diagnostico — e ele que mostra
o mapa completo.

FERNANDA: mas eu nao tenho dinheiro pra nada disso

⚠️ PONTO CRITICO: Lead explicitamente sem dinheiro.
O agente nao pode insistir.

AGENTE:
Fernanda, entendo perfeitamente. Sem pressao nenhuma.

O que conversamos aqui ja te ajuda a entender melhor
o que ta acontecendo. O guia que te mandei tambem.

Quando o momento for certo, o diagnostico ta la.
No site voce ve todas as informacoes:

[LINK]

E se em qualquer momento quiser conversar de novo,
e so me chamar. To aqui.

Te desejo o melhor, de verdade.

FERNANDA: obrigada
```

**Resultado:** Lead recebeu link mas provavelmente NAO vai converter agora. Lead quente para remarketing futuro.

**Observacoes:**
- ⚠️ Lead sem renda — conversao improvavel
- ⚠️ Aceitou ebook (bom — mantem vinculo educativo)
- ⚠️ "Nao tenho dinheiro" — agente encerrou corretamente sem pressao
- ❌ **FRAQUEZA:** O agente nao ofereceu handoff para closer. Closer poderia ter parcelamento, desconto, ou orientacao alternativa. Regra atual so faz handoff se usuario pedir.
- ✅ Tom empatetico mantido

---

## SIMULACAO 3: Divida Urgente — Agressivo e impaciente

**Perfil:** Ricardo, 41 anos. Empresario. Negativado por pendencia antiga. Precisa de capital de giro. Sem paciencia para conversa.

### Conversa

```
RICARDO: Boa. Quanto custa pra limpar o nome?

⚠️ PRIMEIRA MENSAGEM JA PEDE PRECO.

AGENTE (Fase 1):
Oi! Eu sou o Augusto, consultor de credito da CredPositivo.

Antes de falar de valores, preciso entender sua situacao.
Cada caso precisa de uma abordagem diferente. Me conta:
o que ta acontecendo com seu credito?

RICARDO: Tenho uma divida antiga do banco que ja paguei
e continua aparecendo. Preciso do nome limpo pra conseguir
capital de giro. Quanto custa?

AGENTE:
Entendo a pressa. Me ajuda com uma coisa rapida:
essa divida que voce pagou, pagou direto com o banco
ou foi em negociacao tipo feirao?

RICARDO: Direto com o banco. Tem comprovante e tudo.
Me fala o preco que eu resolvo agora.

⚠️ TERCEIRA PERGUNTA DE PRECO. Gatilho de handoff
segundo 08-handoff-rules.md (insistencia em preco 2+).

AGENTE:
Ricardo, entendo. Vou ser direto:

As informacoes de investimento estao no nosso site.
Mas posso te conectar com nosso especialista agora
pra resolver mais rapido. Ele te orienta sobre tudo.

O que prefere: ver no site ou falar com o especialista?

RICARDO: Me passa pro especialista.

AGENTE:
Feito. Vou te conectar agora. Ele ja vai ter o contexto
do que conversamos. Voce nao precisa repetir nada.

Um momento...
```

**(Handoff com resumo parcial — Fase 2 incompleta)**

**Resultado:** Handoff na Fase 2. Conversa durou 4 trocas.

**Observacoes:**
- ⚠️ Pediu preco 3x — gatilho de handoff disparado corretamente
- ⚠️ Agente nao conseguiu chegar na Fase 3 (zero educacao)
- ⚠️ Resumo para closer sera fino (pouca informacao coletada)
- ❌ **FRAQUEZA:** O closer recebe um lead com quase nenhuma informacao. Precisa de protocolo de "handoff magro".
- ✅ Nao insistiu. Ofereceu opcoes. Handoff rapido.

---

## SIMULACAO 4: Nome Limpo mas Negado — Confuso

**Perfil:** Juliana, 31 anos. Pagou todas as dividas ha 6 meses. Nome limpo no Serasa. Mas todo credito e negado. Nao entende por que.

### Conversa

```
JULIANA: Oi, meu nome ta limpo mas nao consigo credito
em lugar nenhum. Nao sei mais o que fazer.

AGENTE (Fase 1):
Oi, Juliana! Eu sou o Augusto, consultor de credito
da CredPositivo.

Isso que voce descreve e mais comum do que parece.
Quero entender melhor pra te explicar o que pode
estar acontecendo. Me conta: quando voce limpou o nome?

JULIANA: Faz uns 6 meses. Paguei tudo no feirao da Serasa.

AGENTE (Fase 2):
Entendi. E de la pra ca, tentou pedir credito onde?

JULIANA: Pedi cartao no Nubank, Itau e Inter. Todos negaram.
Ate consignado no banco do trabalho negaram.

AGENTE:
Poxa. E algum deu motivo?

JULIANA: Nao. So "nao aprovado" e pronto.

AGENTE:
Voce tem conta em quais bancos?

JULIANA: Bradesco ha 8 anos e Nubank ha 3.

AGENTE:
Movimenta com frequencia? Recebe salario por la?

JULIANA: Salario cai no Bradesco. Uso o Nubank pra dia a dia.

AGENTE:
Ja teve cartao antes?

JULIANA: Tinha do Bradesco. Cancelaram quando negativei.
Depois que limpei o nome tentei pedir de volta e negaram.

AGENTE (Ebook):
Juliana, antes de te explicar o que ta acontecendo,
quero te mandar um guia que a gente preparou sobre como
funciona o mercado de credito. Acho que vai fazer muita
coisa fazer sentido. Posso te mandar?

JULIANA: Pode sim!

AGENTE:
Aqui ta:
[ENVIAR PDF]
Olha quando puder. Agora vou te explicar o seu caso.

AGENTE (Fase 3):
Juliana, isso que ta acontecendo com voce e um dos casos
mais comuns -- e mais frustantes.

Quando voce limpa o nome, voce remove a negativacao dos
orgaos de protecao (Serasa, SPC). Mas o banco nao consulta
SO o Serasa. Ele consulta o Bacen e o SCR.

E la continua tudo:
1. Historico de inadimplencia com o cartao Bradesco
2. As dividas negociadas no feirao -- mesmo pagas, ficam
   registradas como "negociacao de inadimplencia"
3. Seu perfil bancario foi danificado quando perdeu o cartao

Voce sabia que o Serasa e so a "vitrine"? O raio-x
de verdade ta no Bacen. E e isso que o banco ve.

JULIANA: Nossa, nao sabia. Entao paguei tudo e nao
adiantou nada??

AGENTE:
Adiantou sim -- foi o primeiro passo. Mas sem reconstruir
o perfil bancario, o banco continua vendo o historico.

Existem acoes especificas pra isso:
- O diagnostico mostra exatamente o que ta no Bacen e SCR
- Depois, dependendo do caso, existe a reconstrucao do
  perfil bancario -- que trabalha os fatores que os bancos
  realmente analisam

No seu caso, o diagnostico confirma as hipoteses que
levantamos aqui. E o proximo passo logico.

JULIANA: Como faco?

AGENTE (Fase 4):
E pelo site. La voce cria sua conta, ve todos os detalhes
e inicia quando quiser:

[LINK]

Qualquer duvida, to aqui.

JULIANA: Vou entrar agora. Obrigada, Augusto!

AGENTE:
Eu que agradeco, Juliana! Qualquer coisa, to aqui.
```

**Resultado:** Lead engajada. Alta probabilidade de conversao. Aceitar ir ao site na Fase 4 de forma natural.

**Observacoes:**
- ✅ Caso perfeito para o design: Fase 3 gera "aha moment"
- ✅ Ebook aceito e reforça credibilidade
- ✅ "Como faco?" = sinal ideal de envio ao site
- ✅ Nenhuma pergunta de preco (conviccao construida)
- ✅ Zero resistencia

---

## SIMULACAO 5: Nome Limpo mas Negado — Cetico

**Perfil:** Carlos, 45 anos. Pagou dividas ha 1 ano. Ainda negado. Ja contratou 2 empresas que "nao fizeram nada". Cansado de promessas.

### Conversa

```
CARLOS: Ja contratei 2 empresas pra limpar meu nome.
Paguei e nao resolveu. Voces sao diferentes como?

AGENTE (Fase 1):
Oi, Carlos! Entendo sua desconfianca. Faz sentido
depois de 2 experiencias ruins.

Nao vou te prometer nada. Quero entender o que
aconteceu pra te dar uma orientacao real.
Me conta: o que essas empresas fizeram?

CARLOS: Falaram que iam limpar meu nome. Pagaram as
dividas e pronto. Mas continuo sem conseguir credito.

AGENTE (Fase 2):
E seu nome ta limpo no Serasa hoje?

CARLOS: Ta. Desde o ano passado. Score 680.

AGENTE:
Score 680 e razoavel. E ainda assim negado. Me diz:
tentou credito onde recentemente?

CARLOS: Itau, Santander, Nubank. Todos negaram.
Ate a C&A negou.

AGENTE:
Tem conta em algum desses bancos?

CARLOS: Itau ha 12 anos.

AGENTE:
E qual era a divida original? Era com o Itau?

CARLOS: Era. Cartao e cheque especial. Entrei no
rotativo e virou uma bola de neve.

AGENTE (Fase 3):
Carlos, agora faz sentido o que aconteceu.

As empresas que voce contratou fizeram limpa nome:
tiraram a negativacao do Serasa e SPC. Isso elas
cumpriram.

Mas o problema e que o Itau -- que e onde voce
tem conta ha 12 anos -- ainda ve no sistema interno
o historico de inadimplencia com cartao e cheque especial.

E quando voce pede credito no Itau, ele consulta o Bacen.
E os outros bancos tambem consultam. E la aparece:
"cliente com historico de inadimplencia em produto X
no banco Y."

Entao nao e que as empresas foram golpe. E que elas
fizeram so metade do trabalho. Limpar nome e o passo 1.
O passo 2 e reconstruir o perfil bancario.

CARLOS: E voces fazem esse passo 2?

AGENTE:
Sim. Mas comecar pelo diagnostico -- pra ver exatamente
o que ta no Bacen e SCR do seu caso. Porque o passo 2
depende do que o raio-x mostrar.

CARLOS: E se eu pagar e nao resolver de novo?

⚠️ PONTO CRITICO: Objecao de confianca. Queimado por
experiencias anteriores.

AGENTE:
Carlos, vou ser transparente: nao consigo te garantir
resultado especifico. Ninguem pode. E se alguem prometer,
desconfia.

O que o diagnostico faz e te dar clareza: mostra
exatamente o que ta travando. Com essa informacao,
voce decide o que fazer. Nao e no escuro.

E diferente de pagar pra alguem "limpar nome" sem
voce saber o que ta acontecendo de verdade.

CARLOS: Faz sentido. Deixa eu ver o site.

AGENTE (Fase 4):
Aqui ta o link:

[LINK]

La voce ve todos os detalhes. Sem compromisso.
E se quiser conversar mais antes de decidir, to aqui.

CARLOS: ok vou olhar
```

**Resultado:** Lead convencido. Resistencia alta superada pela transparencia.

**Observacoes:**
- ✅ "Nao consigo te garantir resultado" gerou confianca (paradoxo)
- ✅ Explicou POR QUE as empresas anteriores nao resolveram
- ⚠️ "E se eu pagar e nao resolver?" — momento de potencial abandono
- ✅ Aceitou ir ao site apos Fase 3 completa
- ❌ **FRAQUEZA:** Nao perguntou preco, mas a objecao de custo-beneficio e implicita. O site precisa ter garantia/politica de reembolso clara.

---

## SIMULACAO 6: Renda Alta sem Credito — Profissional autonomo

**Perfil:** Thiago, 36 anos. Medico recem-formado. Renda alta (R$15k/mes). Nunca teve divida. Score acima de 700. Negado para financiamento imobiliario. Nao entende.

### Conversa

```
THIAGO: Boa noite. Sou medico, ganho bem, nunca tive
divida e me negaram o financiamento. Nao faz sentido.

AGENTE (Fase 1):
Oi, Thiago! Realmente parece nao fazer sentido,
mas existe uma explicacao.

Me ajuda a entender melhor: o financiamento era
com qual banco?

THIAGO: Caixa. Financiamento imobiliario pelo SBPE.

AGENTE (Fase 2):
Sabe quanto era o valor e a entrada?

THIAGO: Imovel de 600 mil, entrada de 150 mil.

AGENTE:
E voce compova renda como? CLT ou autonomo?

THIAGO: Autonomo. Sou PJ.

AGENTE:
Tem conta na Caixa?

THIAGO: Nao. Tenho no Itau.

AGENTE:
Ha quanto tempo no Itau?

THIAGO: 4 anos. Desde a residencia.

AGENTE:
Tem cartao de credito? Usa com frequencia?

THIAGO: Tenho do Itau. Limite de 8 mil. Uso todo mes.

AGENTE (Fase 3):
Thiago, agora entendo. Seu caso e o que a gente chama
de "perfil fino" — mas com um twist.

Voce nunca teve divida, score alto, renda boa. Mas
pro banco, especificamente pra Caixa:

1. Voce nao e cliente da Caixa. Sem relacionamento.
2. Voce e PJ/autonomo — o banco exige mais comprovacao
   de renda estavel
3. Seu historico bancario e recente — 4 anos pro banco
   e "pouco" pra um financiamento de 600 mil
4. Limite de 8 mil no cartao vs. financiamento de 450 mil
   — a proporcao assusta o modelo de risco do banco

Nao e que voce e mau pagador. E que o banco nao tem
dados suficientes pra te classificar como bom pagador
de longo prazo.

THIAGO: Serio? Entao score alto nao serve pra nada?

AGENTE:
Score ajuda, mas e so um dos fatores. Cada banco tem
modelo interno. E pra financiamento imobiliario, que
e credito de longo prazo, eles sao muito mais rigorosos.

Existem acoes pra isso. O diagnostico mostra exatamente
o que a Caixa (ou outro banco) ta vendo no seu perfil.
E a reconstrucao do perfil trabalha esses fatores:
movimentacao, tempo de relacionamento, proporcao
credito/renda.

No seu caso, o diagnostico seria o primeiro passo
pra entender exatamente onde ta a trava.

THIAGO: Faz sentido. Manda o link.

AGENTE (Fase 4):
Aqui ta:

[LINK]

La voce cria sua conta e ve os detalhes. Qualquer
duvida, to aqui.

THIAGO: Valeu, vou ver agora.
```

**Resultado:** Conversao rapida. Fase 3 "aha moment" muito forte para este perfil.

**Observacoes:**
- ✅ Perfil ideal para o design: confusao + alta capacidade de pagamento
- ✅ Explicacao sobre "perfil fino" gera surpresa e confianca
- ✅ "Manda o link" sem perguntar preco — conviccao maxima
- ✅ Nenhuma resistencia
- ⚠️ Risco: lead pode achar R$97 pouco serio pra alguem que ganha R$15k (pode esperar servico mais sofisticado)

---

## SIMULACAO 7: Renda Alta sem Credito — Imigrante retornado

**Perfil:** Patricia, 39 anos. Morou 8 anos nos EUA. Voltou ao Brasil. Renda boa. Zero historico de credito no Brasil.

### Conversa

```
PATRICIA: Ola! Morei nos EUA 8 anos e voltei pro Brasil.
Nao consigo abrir credito em nenhum banco. Podem me ajudar?

AGENTE (Fase 1):
Oi, Patricia! Bem-vinda de volta!

Esse e um caso especifico. Quero entender melhor pra
te orientar. Voce ja tem conta em algum banco aqui?

PATRICIA: Abri no Itau quando voltei, faz 3 meses.

AGENTE (Fase 2):
E ja pediu credito em algum lugar?

PATRICIA: Cartao no Itau negaram. Nubank negou tambem.
Ate a Renner negou.

AGENTE:
Voce tem CPF ativo?

PATRICIA: Sim, nunca cancelei. Mas ficou parado 8 anos.

AGENTE:
Score esta quanto, sabe?

PATRICIA: No Serasa aparece 500. Mas eu nao devo nada!

AGENTE:
E voce comprova renda como?

PATRICIA: Trabalho remoto pra empresa americana.
Recebo em dolar via transferencia.

⚠️ Renda atipica. Comprovacao complicada para bancos.

AGENTE:
Entendi. Voce tem alguma divida no Brasil?

PATRICIA: Nenhuma. Nunca tive.

AGENTE (Fase 3):
Patricia, seu caso e o que chamam de "thin file"
ou perfil fino.

Voce nao tem nenhum problema. O problema e a
AUSENCIA de historico. Pra o banco e como pedir
referencia pra alguem que nunca trabalhou.

Seu CPF ficou 8 anos sem movimentacao. Nenhum banco
te conhece. E seu score de 500 nao e por divida —
e por falta de dados.

Alem disso, sua renda em dolar via transferencia
nao e "comprovacao padrao" pro banco brasileiro.
Eles nao sabem interpretar isso.

A boa noticia: seu caso TEM solucao. Mas precisa
de estrategia — nao e so abrir conta e esperar.

O diagnostico mostra como os bancos estao te vendo
e a reconstrucao do perfil trabalha a estrategia
de reentrada no sistema bancario.

PATRICIA: Nunca imaginei que voltar pro Brasil seria
tao complicado assim. Onde eu vejo mais sobre isso?

AGENTE (Fase 4):
No nosso site voce ve todos os detalhes:

[LINK]

La voce cria sua conta e ve como funciona.
Qualquer duvida, to aqui pra ajudar.

PATRICIA: Obrigada! Vou olhar.
```

**Resultado:** Lead convencida. Alta probabilidade de conversao.

**Observacoes:**
- ✅ Explicacao de "thin file" e nova e gera "aha moment"
- ✅ "Onde eu vejo mais?" = sinal forte
- ✅ Nenhuma resistencia
- ⚠️ **Potencial problema:** "Reconstrucao de perfil bancario" pode parecer vago pra quem nao tem perfil nenhum. O site precisa ter caso de uso para "construcao" (nao so reconstrucao).

---

## SIMULACAO 8: Desconfiado — "Isso e golpe?"

**Perfil:** Ana, 25 anos. Viu anuncio no Instagram. Negativada. Desconfiada de tudo online.

### Conversa

```
ANA: vi voces no instagram. isso e real? ja vi muita
empresa que e golpe

AGENTE (Fase 1):
Oi, Ana! Tem razao de desconfiar. Tem muita coisa
ruim por ai.

Nao vou te pedir nada agora — nem CPF, nem dinheiro.
To aqui pra entender sua situacao e te orientar.

Se no final fizer sentido, ai voce decide. Sem pressao.
Posso te fazer umas perguntas?

ANA: ta bom. mas se pedir cpf eu saio

AGENTE:
Combinado. Nao vou pedir.
Me conta: o que ta acontecendo com seu credito?

ANA: meu nome ta sujo faz 1 ano. nao consigo nem
cartao de loja

AGENTE (Fase 2):
Entendi. Sabe quais dividas aparecem?

ANA: uma do santander e acho que da tim

AGENTE:
Ja tentou negociar?

ANA: nao. nao confio nesses feirao

AGENTE:
E voce tem conta em algum banco?

ANA: inter. mas nem uso direito

AGENTE:
Ha quanto tempo?

ANA: sei la, uns 2 anos

AGENTE (Ebook):
Ana, quero te mandar um material que explica como
funciona o credito no Brasil. E gratuito e educativo.
Acho que vai te ajudar a entender melhor o que vou
te explicar. Posso te mandar?

ANA: e pdf? nao clico em link nao

⚠️ PONTO CRITICO: Desconfianca do formato.

AGENTE:
E um PDF sim, que eu mando direto aqui no WhatsApp.
Nao precisa clicar em nenhum link externo.

ANA: ah ta. pode mandar

AGENTE:
[ENVIAR PDF]
Olha quando puder.

AGENTE (Fase 3):
Ana, pelo que voce me contou:

A negativacao do Santander e da Tim provavelmente
estao impactando seu CPF. Mas o que pouca gente
sabe e que o banco consulta alem do Serasa.

Ele consulta o Bacen e ve historico de pagamento,
restritivos, e como voce usa sua conta. Sua conta
no Inter sem movimentacao nao ajuda -- na verdade
conta parada pode atrapalhar.

Existem acoes possiveis. Mas o primeiro passo e
o diagnostico — um raio-x que mostra tudo que
os bancos veem.

ANA: e quanto custa isso?

AGENTE:
No site tem todas as informacoes. Voce ve tudo antes
de decidir qualquer coisa.

ANA: nao quero entrar em site nenhum

⚠️ PONTO CRITICO: Recusa de ir ao site.
Design atual nao cobre este cenario bem.

AGENTE:
Entendo, Ana. Sem problema.

Se preferir, posso te conectar com nosso especialista.
Ai voce conversa diretamente com ele e tira todas as
duvidas antes de decidir qualquer coisa.

ANA: pode ser

AGENTE:
Vou te conectar agora. Ele ja tem o contexto da
nossa conversa. Voce nao precisa repetir nada.

Um momento...
```

**(Handoff para closer)**

**Resultado:** Lead nao aceita ir ao site. Handoff para closer na Fase 4.

**Observacoes:**
- ⚠️ "Nao clico em link" — quase perdeu na oferta do ebook
- ❌ **FRAQUEZA CRITICA:** "Nao quero entrar em site nenhum" — o design INTEIRO depende de enviar ao site. Se o lead recusa, o unico caminho e handoff. Mas e se o closer tambem nao conseguir?
- ⚠️ Lead mapeada mas o agente teve que improvisar
- ✅ Handoff correto como alternativa
- ❌ **RECOMENDACAO:** Precisa de protocolo claro para "lead que recusa site"

---

## SIMULACAO 9: Desconfiado — "Me prova que funciona"

**Perfil:** Roberto, 50 anos. Desconfiado mas curioso. Quer prova antes de qualquer coisa. "Cade os resultados?"

### Conversa

```
ROBERTO: Voces tem resultado comprovado? Quero ver antes
de perder meu tempo.

AGENTE (Fase 1):
Oi, Roberto! Entendo. Vou ser direto: nao vou te mostrar
promessa de resultado porque credito depende de cada caso.

Mas posso te mostrar em poucos minutos o que provavelmente
ta acontecendo no SEU caso. Ai voce decide se faz sentido.

Me conta: qual a sua situacao hoje?

ROBERTO: Paguei todas as dividas, nome limpo, score 720
e continuo sendo negado. Se voces sao bons, me explica isso.

⚠️ "Me prova" — tom de desafio.

AGENTE (Fase 2):
Boa pergunta. Vamos la:

Em qual banco pediu credito?

ROBERTO: Bradesco. Cartao e emprestimo.

AGENTE:
Ha quanto tempo limpou o nome?

ROBERTO: 8 meses.

AGENTE:
A divida era com o Bradesco?

ROBERTO: Era.

AGENTE:
Tem conta no Bradesco?

ROBERTO: Tenho ha 15 anos.

AGENTE:
E antes da divida, tinha cartao la?

ROBERTO: Tinha. Limite de 20 mil. Cancelaram.

AGENTE (Fase 3):
Roberto, aqui esta a explicacao:

Voce tem 15 anos de Bradesco. Mas nos ultimos anos
o banco registrou internamente: inadimplencia + perda
de cartao com limite alto + divida negociada.

Voce limpou no Serasa? Sim. Mas o Bradesco consulta
o PROPRIO sistema + Bacen/SCR. E la ta tudo:

- Historico de default no cartao
- Cheque especial ou limite estourado (se teve)
- Divida que precisou de negociacao pra pagar

Score 720 no Serasa nao apaga o que o Bradesco ve
no sistema interno. Pra ele, voce foi um cliente que
deu prejuizo. E vai levar tempo -- ou estrategia --
pra mudar isso.

ROBERTO: Hmm. Isso faz sentido. Mas o que voces fazem
de diferente dessas empresas de "limpa nome"?

AGENTE:
A maioria so tira a negativacao do Serasa/SPC. O que
a gente faz comeca pelo diagnostico: um raio-x que
acessa o Bacen e SCR — mostra EXATAMENTE o que o
banco ve. Sem isso, qualquer acao e no escuro.

Depois, dependendo do caso, existe a reconstrucao do
perfil bancario — que trabalha os fatores internos.

Nao e limpar nome. E reconstruir como o banco te ve.

ROBERTO: Certo. Me manda esse site pra eu ver.

AGENTE (Fase 4):
Aqui ta:

[LINK]

La tem todos os detalhes. Sem compromisso.

ROBERTO: Vou olhar.
```

**Resultado:** Lead convencido pela demonstracao de expertise. Aceitou site.

**Observacoes:**
- ✅ "Me prova" virou oportunidade perfeita para Fase 3
- ✅ Agente demonstrou expertise real sem prometer
- ✅ Diferenciacao de "limpa nome" convenceu
- ✅ "Me manda esse site" = aceitacao organica
- ⚠️ Se a Fase 3 tivesse sido fraca, esse lead teria abandonado

---

## SIMULACAO 10: Desconfiado — "Voce e um robo?"

**Perfil:** Camila, 27 anos. Tech-savvy. Desconfiada de bots. Quer falar com humano.

### Conversa

```
CAMILA: Isso e um bot?

AGENTE (Fase 1):
Oi, Camila! Sou o Augusto, consultor de credito.
Uso tecnologia pra te atender mais rapido, mas
tem uma equipe humana por tras.

Se preferir falar diretamente com nosso especialista,
posso te conectar agora. Ou, se quiser, me conta sua
situacao que eu te oriento.

CAMILA: Eu sabia. E um bot. Me passa pra alguem real.

⚠️ Gatilho de handoff: "Nao quero falar com robo" /
"Isso e automatico?" — handoff imediato segundo regras.

AGENTE:
Claro! Vou te conectar agora com nosso especialista.
So me deixa anotar o que voce me contou pra ele ja ter
contexto e voce nao precisar repetir nada.

CAMILA: Voce nao sabe nada sobre mim, acabei de chegar.

AGENTE:
Verdade! Entao vou te conectar diretamente.
Um momento...
```

**(Handoff imediato. Resumo: "Lead chegou agora, nao quis interagir com o agente. Nenhuma informacao coletada.")**

**Resultado:** Handoff na primeira troca. Zero informacao coletada.

**Observacoes:**
- ⚠️ Conversa mais curta possivel (2 trocas)
- ❌ **FRAQUEZA:** Resumo para closer = vazio. Closer entra 100% no escuro.
- ⚠️ "Uso tecnologia pra te atender" — formulacao ambigua. Lead tech-savvy detectou imediatamente.
- ❌ **RECOMENDACAO:** Quando handoff acontece com zero informacao, o closer precisa de um script especifico de abertura que investiga do zero. Protocolo nao esta coberto em `08-handoff-rules.md`.
- ❓ **QUESTAO DE DESIGN:** O agente deveria admitir que e AI? Ou manter a ambiguidade?

---

## SIMULACAO 11: Sensivel a Preco — Pergunta logo

**Perfil:** Lucas, 30 anos. Negativado. Interessado mas sensivel a preco. Quer saber quanto custa antes de investir tempo.

### Conversa

```
LUCAS: Quanto custa o diagnostico?

AGENTE (Fase 1):
Oi, Lucas! As informacoes de investimento estao no
nosso site. Mas antes de pensar nisso, posso te ajudar
a entender o que ta acontecendo com seu credito?

Assim voce sabe se o diagnostico faz sentido pro seu caso.
Me conta: qual a sua situacao?

LUCAS: To negativado. Quero saber o preco primeiro pra
ver se posso pagar.

AGENTE:
Entendo. E justo.
No site tem os detalhes:

[LINK]

Mas se quiser, posso te mostrar em poucos minutos o que
provavelmente ta travando seu credito. Ai voce decide
com mais informacao. O que prefere?

LUCAS: Ta. Me fala entao.

AGENTE (Fase 2):
Beleza! Voce sabe quais dividas aparecem no seu CPF?

LUCAS: Uma da Magazine Luiza de 2 anos atras.

AGENTE:
E ja tentou credito recentemente?

LUCAS: Pedi cartao no Mercado Pago e negaram.

AGENTE:
Tem conta em algum banco?

LUCAS: Nubank.

AGENTE:
Ha quanto tempo?

LUCAS: 1 ano e pouco.

AGENTE (Fase 3):
Lucas, pelo que voce me contou:

A negativacao da Magazine Luiza ta impactando seu CPF
no Serasa/SPC. Mas o Mercado Pago consulta mais que
isso — ele ve o Bacen tambem.

Sua conta no Nubank e recente e provavelmente nao tem
movimentacao forte. Pra o banco, voce e um perfil
de risco: negativado + historico curto + sem cartao
de credito anterior.

O diagnostico e o que mostra exatamente o que ta
travando e monta o mapa de acao. E o primeiro passo.

LUCAS: ta. mas eu preciso saber o preco antes.
nao vou entrar no site sem saber

⚠️ PONTO CRITICO: Lead insiste no preco.
Design diz "nunca mencione preco". Mas lead
vai embora se nao souber.

AGENTE:
Lucas, no site voce ve o valor e todos os detalhes
antes de decidir qualquer coisa. Nao tem compromisso.

Se preferir, posso te conectar com nosso especialista
pra tirar suas duvidas diretamente.

LUCAS: cara me fala o valor aqui que eu decido agora

⚠️ TERCEIRA INSISTENCIA. Gatilho de handoff.

AGENTE:
Entendo, Lucas. Vou te conectar com nosso especialista.
Ele pode te dar mais detalhes. Tudo bem?

LUCAS: tá pode ser

AGENTE:
Vou te conectar agora. Um momento...
```

**(Handoff para closer com nota: "Lead quer saber preco. Insistiu 3x. Nao quis ir ao site sem saber valor.")**

**Resultado:** Handoff por insistencia em preco. Lead potencialmente perdido se closer nao responder rapido.

**Observacoes:**
- ❌ **FRAQUEZA CRITICA:** A regra "nunca dizer preco" frustra leads sensiveis a preco e cria atrito desnecessario. O lead quer uma informacao simples e se sente enrolado.
- ⚠️ 3 perguntas de preco = 3 desvios do agente = impressao de enrolacao
- ⚠️ Se o closer demorar, lead esfria
- ❓ **QUESTAO DE DESIGN:** Se o preco esta no site publicamente, por que o agente nao pode dizer? A barreira parece artificial para leads que ja perguntaram diretamente.

---

## SIMULACAO 12: Sensivel a Preco — Compara com concorrente

**Perfil:** Michele, 33 anos. Pesquisou outros servicos. Quer comparar.

### Conversa

```
MICHELE: Oi. To comparando servicos de credito.
Quero saber o que voces oferecem e o preco.

AGENTE (Fase 1):
Oi, Michele! Que bom que voce ta pesquisando.

Posso te explicar como funciona nosso trabalho.
Mas cada caso e diferente, entao ajuda se eu entender
um pouco da sua situacao primeiro. Me conta:
o que ta acontecendo com seu credito?

MICHELE: Meu nome ta sujo faz 3 anos. Quero limpar
e ter credito de novo. Ja peguei orcamento em 2 lugares.

AGENTE (Fase 2):
Entendi. Os outros lugares te falaram o que fariam?

MICHELE: Um falou que limpa o nome em 15 dias por R$400.
Outro falou que aumenta o score por R$800.

⚠️ Leads ja tem referencia de preco dos concorrentes.

AGENTE:
Interessante. Nenhum falou em diagnostico antes?

MICHELE: Nao. Os dois falaram "manda seu CPF que a gente resolve".

AGENTE:
E voce mandou?

MICHELE: Nao. Achei estranho.

AGENTE:
Boa decisao. Deixa eu te perguntar: voce sabe quais
dividas aparecem no seu CPF?

MICHELE: Cartao do Bradesco e emprestimo da Crefisa.

AGENTE:
E ja tentou pedir credito recentemente?

MICHELE: Tentei financiar uma moto no banco. Negaram.

AGENTE (Fase 3):
Michele, vou te explicar uma coisa que a maioria dessas
empresas nao conta:

"Limpar nome" remove a negativacao do Serasa/SPC.
"Aumentar score" ninguem faz — score e calculado
automaticamente. Se alguem promete isso, desconfia.

O que o banco realmente analisa e o seu perfil no Bacen
e SCR. E la que aparece tudo: historico de pagamento,
relacionamento, restritivos.

Se voce limpar o nome sem saber o que ta no Bacen,
pode continuar sendo negada. Foi o que aconteceu com
muita gente.

O nosso processo e diferente: comecar pelo diagnostico
pra ver o quadro completo. Depois, com base no resultado,
definir se precisa de limpeza, reconstrucao de perfil,
ou os dois. Nessa ordem.

MICHELE: Hmm. Faz mais sentido. Quanto e o diagnostico?

AGENTE (Fase 4):
No site tem todas as informacoes de investimento.
La voce ve os detalhes e compara:

[LINK]

E se tiver duvidas depois de ver, to aqui ou posso
te conectar com nosso especialista.

MICHELE: Vou ver. Se for caro, ja aviso.

AGENTE:
Sem problema! Olha com calma.
```

**Resultado:** Lead engajada. Vai ao site. Conversao depende do preco no site vs. concorrentes.

**Observacoes:**
- ✅ Diferenciacao dos concorrentes foi forte
- ✅ "Score ninguem faz" gera autoridade
- ⚠️ "Se for caro ja aviso" — risco de abandono no site
- ⚠️ Concorrentes cobram R$400-800 para "resolver". CredPositivo cobra R$97 so pro diagnostico + R$600-1200 para servicos. Comparacao pode ser desfavoravel se o lead nao entender a diferenca.
- ❌ **FRAQUEZA:** O site precisa de uma secao de comparacao "por que somos diferentes" pra leads que chegam comparando.

---

## SIMULACAO 13: Sensivel a Preco — "Nao tenho dinheiro"

**Perfil:** Joao, 22 anos. Primeiro emprego. Negativado por conta de celular. Score baixo. Sem renda pra investir em servico.

### Conversa

```
JOAO: oi, meu nome ta sujo por causa de um celular
que financiei e nao paguei. tem como resolver?

AGENTE (Fase 1):
Oi, Joao! Sim, tem como entender sua situacao e ver
o que pode ser feito. Me conta mais: faz quanto tempo?

JOAO: uns 2 anos. a divida era 1500 reais

AGENTE (Fase 2):
E voce ta trabalhando hoje?

JOAO: to no primeiro emprego. ganho um salario minimo

AGENTE:
Tem conta em algum banco?

JOAO: no banco do emprego. caixa

AGENTE:
Ja tentou pedir credito?

JOAO: pedi cartao no nubank e negaram

AGENTE (Fase 3):
Joao, sua situacao e bem comum pra quem e jovem.

O financiamento do celular gerou uma negativacao que ta
no seu CPF. Pro Nubank, voce e um perfil de risco:
negativado + historico curto + renda inicial.

A boa noticia: voce e jovem e ta no primeiro emprego.
Com as acoes certas, da pra reconstruir rapido.

O diagnostico mostra exatamente o que ta travando.
E depois, dependendo do resultado, existem acoes
pra limpar e reconstruir.

JOAO: quanto custa? pq nao tenho muito dinheiro nao

AGENTE (Fase 4):
Entendo, Joao. No site voce ve todas as informacoes
e decide se faz sentido pra voce:

[LINK]

Sem compromisso.

JOAO: cara 97 reais e muito pra mim agora.
posso pagar em 2x?

⚠️ Lead viu o preco no site e voltou.

AGENTE:
Joao, entendo. Se quiser, posso te conectar com nosso
especialista pra ver as opcoes. Quer que eu conecte?

JOAO: pode ser

AGENTE:
Vou te conectar agora. Um momento...
```

**(Handoff com nota: "Lead jovem, renda 1 SM, perguntou sobre parcelamento. Quer saber se pode pagar em 2x.")**

**Resultado:** Handoff por questao financeira. Conversao depende do closer oferecer parcelamento.

**Observacoes:**
- ✅ Agente nao tentou resolver a questao de pagamento (correto)
- ✅ Handoff rapido quando lead trouxe restricao financeira
- ⚠️ Lead voltou do site com objecao de preco — o agente nao estava preparado
- ❌ **FRAQUEZA:** Nao ha protocolo para "lead que foi ao site e voltou com objecao". O design assume que quem vai ao site ou compra ou abandona (webhook). Mas e se volta ao WhatsApp?
- ❌ **RECOMENDACAO:** Criar fluxo para "retorno do site com objecao"

---

## SIMULACAO 14: Silencioso — Respostas curtas

**Perfil:** Pedro, 38 anos. Responde com 1-3 palavras. Nao se abre. Dificil de engajar.

### Conversa

```
PEDRO: oi

AGENTE (Fase 1):
Oi, Pedro! Eu sou o Augusto, consultor de credito
da CredPositivo. Me conta: o que ta acontecendo com
seu credito?

PEDRO: nome sujo

AGENTE (Fase 2):
Entendi. Faz quanto tempo?

PEDRO: uns 3 anos

AGENTE:
Sabe quais dividas aparecem?

PEDRO: banco

AGENTE:
Qual banco?

PEDRO: santander

AGENTE:
Ja tentou pedir credito recentemente?

PEDRO: sim

AGENTE:
E foi negado? Em qual lugar?

PEDRO: sim. nubank

AGENTE:
Voce tem conta em algum banco hoje?

PEDRO: santander

⚠️ PONTO CRITICO: 8 trocas e quase nenhuma informacao util.
Lead nao se abre. Agente fica "arrancando" respostas.

AGENTE:
Pedro, com base no que voce me contou, o Santander
provavelmente tem registro de inadimplencia no sistema
interno. Mesmo que voce limpe no Serasa, ele continua
vendo.

O primeiro passo seria um diagnostico pra ver exatamente
o que ta no seu perfil. No site tem os detalhes:

[LINK]

Ou se preferir, posso te conectar com nosso especialista.
O que prefere?

PEDRO: vou ver o site

AGENTE:
Beleza! Qualquer duvida, to aqui.
```

**Resultado:** Lead foi ao site, mas engagement foi baixissimo. Conversao improvavel.

**Observacoes:**
- ⚠️ Fase 3 foi fraca — nao teve material suficiente pra conectar causas
- ⚠️ Ebook nao foi oferecido (lead nao demonstrou engagement suficiente)
- ❌ **FRAQUEZA:** O design assume que o usuario se abre. Com usuarios silenciosos, a Fase 3 nao tem material pra gerar "aha moment". A explicacao fica generica.
- ❌ **RECOMENDACAO:** Precisa de perguntas de "multipla escolha" pro usuario silencioso. Ex: "Voce ta buscando: cartao, emprestimo, ou financiamento?" — reduz atrito de resposta.
- ⚠️ Agente pulou da Fase 2 pra Fase 4 porque nao tinha conteudo pra Fase 3 forte

---

## SIMULACAO 15: Silencioso — Some no meio

**Perfil:** Larissa, 29 anos. Comeca engajada, para de responder na Fase 2.

### Conversa

```
LARISSA: Oi, vi voces no Instagram. To com nome sujo
e quero saber como limpar

AGENTE (Fase 1):
Oi, Larissa! Que bom que voce veio! Vou te ajudar
a entender sua situacao.

Me conta: faz quanto tempo que ta negativada?

LARISSA: uns 8 meses. por causa de cartao do itau

AGENTE (Fase 2):
Entendi. Voce ja tentou negociar com o Itau?

LARISSA: vou ver isso e te falo

[24 HORAS SEM RESPOSTA]

⚠️ TIMEOUT. Entra fluxo de consultation_timeout.

AGENTE (Follow-up +24h):
Oi, Larissa! A gente estava conversando sobre sua
situacao de credito e parece que voce precisou sair.

Sem problema! Quando quiser retomar, estou aqui.
Ja tenho o contexto de tudo que conversamos.

[48 HORAS SEM RESPOSTA]

AGENTE (Follow-up +72h):
Larissa, so passando pra dizer que nosso canal
ta aberto. Quando voce sentir que e o momento,
e so me chamar.

Enquanto isso, nosso Instagram tem conteudo que
pode te ajudar: @credpositivo

Tudo de bom!

[SEM RESPOSTA]

(Encerrar. Lead entra em remarketing.)
```

**Resultado:** Lead abandonou na Fase 2. Follow-up nao recuperou.

**Observacoes:**
- ⚠️ "Vou ver isso e te falo" = sinal classico de abandono educado
- ✅ Follow-up respeitou timing (24h + 72h)
- ✅ Nao foi insistente
- ❌ **FRAQUEZA:** O follow-up de +24h e generico. Nao oferece valor novo. Nao fala "enquanto isso, vi que no seu caso o mais provavel e..." — perde oportunidade de ganchar com insight.
- ❌ **RECOMENDACAO:** Follow-up de timeout deveria incluir um micro-insight da Fase 3: "Larissa, enquanto voce nao voltou, pensei no seu caso. Divida de cartao do Itau geralmente impacta mais do que parece porque o banco consulta o Bacen alem do Serasa. Quando quiser, te explico melhor."

---

---

# RELATORIO DE ANALISE

---

## 1. Momentos de Drop-off

| Momento | Frequencia | Perfis afetados | Gravidade |
|---------|-----------|-----------------|-----------|
| **Pergunta de preco sem resposta satisfatoria** | 5 de 15 | Preco-sensitivo, Urgente, Desconfiado | ALTA |
| **"Nao quero ir ao site"** | 2 de 15 | Desconfiado, Preco-sensitivo | ALTA |
| **Timeout na Fase 2** | 2 de 15 | Silencioso | MEDIA |
| **"Nao tenho dinheiro"** | 2 de 15 | Urgente-emocional, Jovem | MEDIA |
| **Deteccao de bot** | 1 de 15 | Tech-savvy | MEDIA |

**Padrao:** O maior risco de abandono acontece quando o lead PEDE uma informacao simples (preco) e recebe evasao repetida. A percepcao de "enrolacao" e o killer #1.

---

## 2. Pontos de Confusao

| Ponto | Descricao | Simulacoes |
|-------|-----------|------------|
| **Preco no site vs. no WhatsApp** | Lead nao entende por que o agente nao pode dizer o preco se esta publicado no site. Parece contraditorio. | #3, #11, #12, #13 |
| **"Voce e um robo?"** | Resposta ambigua ("uso tecnologia") nao convence leads tech-savvy. | #10 |
| **Diagnostico vs. Limpa Nome** | Lead confunde os dois. Acha que diagnostico JA limpa nome. | #1, #13 |
| **"Reconstrucao de perfil"** | Conceito abstrato. Lead nao entende o que significa na pratica. | #7 |
| **Retorno do site** | Lead vai ao site, volta com duvida, e o agente nao tem protocolo. | #13 |

---

## 3. Quebras de Confianca

| Quebra | Descricao | Gravidade |
|--------|-----------|-----------|
| **Evasao de preco repetida** | Lead pergunta 2-3x e recebe redirecionamento. Sente que ta sendo enrolado. | CRITICA |
| **Ambiguidade sobre ser AI** | Lead tech-savvy detecta bot e perde confianca imediatamente. | ALTA |
| **Promessa implicita de resolver** | Quando o agente diz "existem acoes possiveis", lead assume que garante resultado. | MEDIA |
| **Falta de prova social** | Nenhum momento da conversa mostra depoimento ou caso real. | MEDIA |
| **Follow-up generico** | Mensagem de retomada nao tem insight novo — parece autoresponder. | BAIXA |

---

## 4. Onde Perguntam Preco

| Momento | Frequencia | Contexto |
|---------|-----------|----------|
| **Primeira mensagem** | 3 de 15 | Leads diretos que ja pesquisaram ou vem comparando |
| **Final da Fase 3** (apos explicacao) | 4 de 15 | Lead convencido, quer saber o investimento |
| **Fase 4** (apos receber link) | 2 de 15 | Lead que viu o site e voltou |
| **Na Fase 2** (interrompendo investigacao) | 1 de 15 | Lead impaciente |

**Insight:** 60% das perguntas de preco acontecem DEPOIS da Fase 3, quando o lead ja esta convencido. Nesses casos, a evasao e contraproducente — o lead quer comprar e o agente esta atrapalhando.

---

## 5. Quando Aceitam Ir ao Site

| Momento | Frequencia | Sinal do lead |
|---------|-----------|---------------|
| **Apos "aha moment" da Fase 3** | 6 de 15 | "Faz sentido", "Nao sabia disso", "Como faco?" |
| **Apos insistencia em preco (handoff)** | 3 de 15 | "Me fala o preco" → agente oferece site como alternativa |
| **Apos comparacao com concorrentes** | 1 de 15 | "Voces sao diferentes" |
| **Fase 4 padrao** | 3 de 15 | Aceitacao neutra, "vou ver" |
| **Nao aceita ir ao site** | 2 de 15 | Desconfianca extrema |

**Insight:** O "aha moment" da Fase 3 e o maior driver de aceitacao do site. Quando a Fase 3 e fraca (pouca informacao, usuario silencioso), a aceitacao do site tambem e fraca.

---

## RECOMENDACOES PRIORITARIAS

### CRITICO — Corrigir antes de implementar

| # | Problema | Recomendacao |
|---|----------|--------------|
| 1 | **Evasao de preco frustra leads** | Criar regra: se lead perguntou preco 1x, redirecionar pra investigacao. Se perguntou 2x, enviar link do site imediatamente (nao esperar Fase 4). Se perguntou 3x, handoff para closer. Nao forcar o lead a ficar na conversa. |
| 2 | **"Nao quero ir ao site"** sem protocolo | Criar caminho alternativo: handoff direto para closer quando lead recusa site. Closer pode fechar pelo WhatsApp (excecao ao modelo). |
| 3 | **Lead volta do site com objecao** sem fluxo | Criar protocolo "retorno do site": agente reconhece que o lead viu o site, pergunta qual a duvida, e oferece handoff para closer se for sobre preco/parcelamento. |
| 4 | **Handoff "magro" (pouca info)** prejudica closer | Criar template de "handoff minimo" para closers: script de abertura quando resumo tem pouca informacao. Closer sabe que precisa investigar do zero. |

### ALTO — Melhorar antes do lancamento

| # | Problema | Recomendacao |
|---|----------|--------------|
| 5 | **Usuario silencioso = Fase 3 fraca** | Adicionar perguntas de multipla escolha: "Voce ta buscando resolver: (1) cartao (2) emprestimo (3) financiamento (4) outro". Reduz atrito. Mesmo com respostas curtas, permite Fase 3 mais direcionada. |
| 6 | **Follow-up de timeout generico** | Follow-up de +24h deve incluir 1 micro-insight personalizado do caso: "Divida com [banco] geralmente impacta [X]. Quando quiser, te explico." Gancho educativo, nao cobranca. |
| 7 | **Ambiguidade sobre ser AI** | Decidir: ou admitir explicitamente ("sou um assistente com AI") ou evitar a pergunta com identidade forte ("sou o Augusto, consultor"). Ambiguidade e o pior caminho. |
| 8 | **Zero prova social na conversa** | Adicionar 1 momento na Fase 3: "Muitos dos nossos clientes estavam exatamente nessa situacao -- nome limpo mas negado. Depois do diagnostico, entenderam o que faltava." Nao e caso especifico (compliance), mas valida a experiencia. |

### MEDIO — Refinar pos-lancamento

| # | Problema | Recomendacao |
|---|----------|--------------|
| 9 | **"Reconstrucao de perfil" e abstrato** | Usar analogias mais concretas: "E como reformar a ficha do banco. Tipo um curriculo: a gente melhora o que eles veem quando consultam voce." |
| 10 | **Lead sem renda = dead end** | Criar caminho educativo-only: enviar ebook + conteudo Instagram + "quando o momento for certo, estamos aqui". Manter vinculo sem empurrar compra. |
| 11 | **Confusao diagnostico vs limpa nome** | Na Fase 3, sempre dizer: "O diagnostico NAO limpa nome. Ele mostra o mapa. A limpeza e o passo seguinte, se necessario." |
| 12 | **Site precisa de pagina de comparacao** | Leads que vem comparando concorrentes precisam ver "por que somos diferentes" no site. Agente educa, site confirma. |

---

## MAPA DE CALOR: Fases x Perfis

```
                    F1    F2    F3    F4    F5   SITE
                  Acolh  Inv   Educ  Link  Hand
Urgente-calmo      ✅    ✅    ✅    ✅    --    ✅
Urgente-emocional  ✅    ✅    ✅    ⚠️    --    ❌
Urgente-agressivo  ✅    ❌    --    --    ✅    --
Limpo-confuso      ✅    ✅    ✅✅   ✅    --    ✅
Limpo-cetico       ✅    ✅    ✅✅   ✅    --    ✅
Renda-autonomo     ✅    ✅    ✅✅   ✅    --    ✅
Renda-imigrante    ✅    ✅    ✅    ✅    --    ✅
Desconfiado-golpe  ✅    ✅    ✅    ❌    ✅    --
Desconfiado-prova  ✅    ✅    ✅✅   ✅    --    ✅
Desconfiado-bot    ❌    --    --    --    ✅    --
Preco-direto       ⚠️    ✅    ✅    ⚠️    ✅    --
Preco-comparador   ✅    ✅    ✅    ✅    --    ✅
Preco-sem-renda    ✅    ✅    ✅    ⚠️    ✅    --
Silencioso-curto   ✅    ⚠️    ⚠️    ⚠️    --    ⚠️
Silencioso-sumiu   ✅    ❌    --    --    --    --
```

**Legenda:** ✅ = fluxo normal, ✅✅ = ponto forte, ⚠️ = atrito, ❌ = quebra

**Leitura:** O design funciona muito bem para leads confusos/ceticos com disposicao de conversar (Fase 3 brilha). Falha com leads que querem informacao objetiva rapida (preco) e com leads que nao se abrem.

---

## TAXA DE CONVERSAO ESTIMADA

| Resultado | Quantidade | % |
|-----------|-----------|---|
| Aceitou ir ao site | 8 de 15 | 53% |
| Handoff para closer (preco/preferencia) | 5 de 15 | 33% |
| Abandonou / nao converteu | 2 de 15 | 13% |

**Nota:** Dos 8 que foram ao site, estimativa de 50% convertem (4 de 15 = 27%). Dos 5 handoffs, estimativa de 30% convertem pelo closer (1.5 de 15 = 10%). **Conversao estimada total: ~37%.**

---

*Documento criado como stress test do design de consulta AI -- Fase 2.*
*15 simulacoes, 6 perfis, 12 recomendacoes priorizadas.*
