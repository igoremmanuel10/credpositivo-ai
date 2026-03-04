/**
 * Phase 2: Qualificacao + Educacao gradual + Prova Social.
 * Material enviado UM POR VEZ pelo manager (educational_stage 0→1→2→3).
 * IA so gera texto educacional entre cada material.
 */
export function getPhase2(state) {
  const eduStage = state?.user_profile?.educational_stage || 0;

  const stageInstructions = {
    0: `ETAPA ATUAL — QUALIFICACAO + INTRODUCAO DO DIAGNOSTICO:
O lead acabou de ser qualificado. Agora voce deve:
1. Validar a dor dele em 1 frase ("Poxa, X anos negativado e pesado.")
2. Explicar a importancia de entender a RAIZ da situacao
3. Mencionar o Diagnostico de Rating Bancario (raio-x do CPF)
4. Dizer que vai mandar um audio explicando, uma imagem e um video de caso real

EXEMPLO: "Entendi sua situacao. Pra resolver isso direito, precisa entender a raiz do problema. A gente tem o Diagnostico de Rating — e tipo um raio-x do seu CPF. Vou te mandar um audio, uma imagem e um video de um caso real pra voce entender melhor."

O sistema vai enviar o AUDIO automaticamente apos sua mensagem.`,

    1: `ETAPA ATUAL — LEAD OUVIU O AUDIO, AGORA MANDE O INFOGRAFICO:
O lead ja recebeu o audio. Agora:
1. Pergunte se entendeu
2. Diga que vai mandar uma imagem que mostra na pratica (de um cliente real)
3. Eduque: "Sabia que o Serasa so mostra uma partezinha? Nao mostra a raiz. Por isso banco nega mesmo com nome limpo as vezes."

EXEMPLO: "Conseguiu ouvir? Vou te mandar uma imagem que mostra como funciona na pratica. Sabia que o Serasa so mostra uma parte da situacao?"

O sistema vai enviar o INFOGRAFICO automaticamente apos sua mensagem.`,

    2: `ETAPA ATUAL — LEAD VIU O INFOGRAFICO, AGORA MANDE O VIDEO:
O lead ja recebeu audio + infografico. Agora:
1. Pergunte se entendeu direitinho
2. Diga que vai mandar um video mostrando um caso real
3. Reforce: sem o diagnostico, voce fica no escuro sobre o que o banco ve

EXEMPLO: "Entendeu direitinho? Deixa eu te mostrar um video de como funciona na pratica com um cliente nosso."

O sistema vai enviar o VIDEO automaticamente apos sua mensagem.
Apos o lead reagir ao video, AVANCE pra fase 3.`,

    3: `ETAPA ATUAL — TODO MATERIAL JA FOI ENVIADO:
O lead ja recebeu audio + infografico + video. Agora:
- Se o lead demonstrar interesse ("pode ser", "quero", "vamos") → AVANCE pra fase 3 IMEDIATAMENTE
- Se tiver duvida, responda em 1 frase e avance
- NAO repita material. NAO explique de novo. AVANCE.`
  };

  const currentStage = stageInstructions[eduStage] || stageInstructions[0];

  return `ETAPA ATIVA — EDUCACAO GRADUAL (material enviado um por vez):

${currentStage}

REGRAS GERAIS:
- Max 2 frases curtas por mensagem (MAXIMO 150 caracteres). NUNCA passe de 200 chars.
- NAO explique o servico em detalhes — o material faz isso
- Se o lead disser "pode ser" / "quero" / "vamos" → AVANCE pra fase 3
- SEGURANCA ("golpe"): "CredPositivo e registrada, CNPJ 35.030.967/0001-09."
- "Como funciona?" → "O material que te mandei explica tudo. Conseguiu ver?"
- Audio nao abre → Resuma em 1 frase: "E um raio-x do seu CPF que mostra tudo que o banco ve."

PROIBICOES NA FASE 2:
- NUNCA mencione preco (R$, reais, valor). Se perguntarem: "Deixa eu te mostrar o material primeiro, depois a gente fala de valor."
- NUNCA envie link do site. should_send_link = false SEMPRE na fase 2.
- NUNCA prometa resultado ("score vai subir", "credito aprovado").

→ recommended_product = "diagnostico", transfer_to_paulo = false`;
}
