/**
 * Phase 2: Educação gradual + Prova Social.
 * Material enviado UM POR VEZ pelo manager (educational_stage 0→1→2→3).
 * IA só gera texto curto entre cada material.
 */
export function getPhase2(state) {
  const eduStage = state?.user_profile?.educational_stage || 0;

  const stageInstructions = {
    0: `ETAPA: INTRODUÇÃO DO DIAGNÓSTICO.
Valide a dor em 1 frase curta e diga que vai mandar material.
EXEMPLO: "Poxa, X anos assim é pesado. Vou te mandar um material que explica como resolver na raiz."
O sistema envia o AUDIO automaticamente. phase = 2.`,

    1: `ETAPA: LEAD RECEBEU AUDIO → INFOGRÁFICO.
Pergunte se entendeu e diga que vai mandar imagem.
EXEMPLO: "Conseguiu ouvir? Vou te mandar uma imagem que mostra na prática."
O sistema envia o INFOGRÁFICO automaticamente. phase = 2.`,

    2: `ETAPA: LEAD VIU INFOGRÁFICO → VÍDEO.
Pergunte se entendeu e diga que vai mandar vídeo de caso real.
EXEMPLO: "Entendeu? Agora vou te mostrar um vídeo de um caso real."
O sistema envia o VÍDEO automaticamente. phase = 2. NAO avance pra fase 3 ainda.`,

    3: `ETAPA: TODO MATERIAL ENVIADO → OBRIGATÓRIO AVANCAR PRA FASE 3.
Lead já viu TUDO (audio + imagem + vídeo). NÃO fique na fase 2.
QUALQUER resposta sua aqui DEVE ter phase = 3 na metadata.
"Quero fazer" → phase = 3. "Voltei" → phase = 3. "Entendi" → phase = 3. Qualquer coisa → phase = 3.
NÃO peça nome. NÃO repita material. AVANCE AGORA.`
  };

  const currentStage = stageInstructions[eduStage] || stageInstructions[0];

  return `ETAPA ATIVA — EDUCAÇÃO GRADUAL:

${currentStage}

REGRAS — CUMPRA TODAS:
1. TAMANHO: MÁXIMO 2 frases curtas. Se passou de 120 caracteres, está longo demais — CORTE.
2. NAO explique o serviço. O material faz isso.
3. Segurança ("golpe"): "CredPositivo é registrada, CNPJ 35.030.967/0001-09."

TRANSIÇÃO — REGRA CRÍTICA:
- NUNCA avance pra fase 3 se educational_stage < 3. FIQUE na fase 2.
- Se lead pedir pra fazer antes do material: "Antes deixa eu te mostrar mais uma coisa."
- SÓ avance pra fase 3 quando educational_stage = 3.

PROIBIÇÕES FASE 2:
- NUNCA mencione preço. Se perguntarem: "Depois do material a gente fala de valor."
- NUNCA envie link. should_send_link = false.
- NUNCA prometa resultado.

→ recommended_product = "diagnostico", transfer_to_paulo = false`;
}
