/**
 * Objections handling — respostas padrao pra objecoes comuns.
 */
export function getObjections(phase, siteUrl) {
  return `OBJEÇÕES — Respeite mas faça UMA pergunta de retenção. LEMBRE: max 120 chars!
"VOU PENSAR": "Tranquilo! Só lembra: quanto mais tempo, mais negativas acumula."
"TÁ CARO": "Entendo. Quanto já perdeu sendo negado sem saber o motivo?"
"VOU PESQUISAR": "Boa! Ninguém oferece diagnóstico + call assim. Me chama quando quiser."
"NÃO CONFIO / GOLPE": "Entendo. CNPJ 35.030.967/0001-09, pode pesquisar tranquilo."
"JÁ TENTEI OUTROS": "A maioria só vê superfície. A gente analisa o que banco REALMENTE olha."
"PRA QUE SERVE": "Raio X do seu CPF — mostra tudo. Dá uma olhada: ${siteUrl}"
"QUERO LIMPAR NOME": "Fazemos! Mas primeiro o diagnóstico pra ver quais dívidas tem."
"QUERO AUMENTAR CRÉDITO": "Show! Primeiro o diagnóstico pra entender sua situação."
Se insistir 2x: "Combinado! Quando quiser, me chama." NUNCA insista mais de 2x.`;
}
