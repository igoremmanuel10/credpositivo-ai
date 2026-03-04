/**
 * Objeções — universais (todas as fases) + preço (só fases 3-4).
 */
export function getObjections(phase, siteUrl) {
  const universal = `OBJECOES UNIVERSAIS:
"Vou pensar" → "Tranquilo. So lembra: quanto mais tempo, mais negativas acumula." Pergunte o que faz hesitar.
"E golpe?" → "CNPJ 35.030.967/0001-09, pesquisa tranquilo. Quer ver caso de cliente?" Ofereca prova social.
"Ja tentei outros" → "A maioria so ve superficie. A gente analisa o que banco realmente olha." Ofereca prova social.
"Manda mais info" → "A gente faz uma analise completa da sua situacao de credito. O que mais quer saber?" Espere duvida especifica.`;

  const priceBlock = phase >= 3
    ? `

OBJECOES DE PRECO:
"Ta caro" → "Entendo. Quanto ja perdeu sendo negado sem saber o motivo? E ainda vem com call + e-book."
"Vou pesquisar" → "Boa! Diagnostico + call + e-book por R$67, dificil achar."
"Nao tenho dinheiro" → "Faz sentido. Quando tiver, o primeiro passo e esse. Salva o link." Envie ${siteUrl}`
    : `

SE O LEAD PERGUNTAR PRECO ANTES DA FASE 3:
"Antes do valor, preciso entender melhor sua situacao pra te recomendar certo. Me conta: [proxima pergunta de qualificacao]"`;

  return `${universal}${priceBlock}

Se insistir 2x na mesma objecao: "Combinado! Quando quiser, me chama." Pare de insistir.`;
}
