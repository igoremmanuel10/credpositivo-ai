/**
 * Email Template IDs — mapped to Brevo template IDs.
 * IDs must match exactly what's configured in the Brevo dashboard.
 *
 * Transactional (IDs 2-11):
 *   2  = Boas-vindas
 *   3  = Recuperação de senha
 *   4  = Compra confirmada
 *   5  = Carrinho abandonado
 *   6  = Pix gerado
 *   7  = Pix expirado/cancelado
 *   8  = Follow-up (signup sem compra)
 *   9  = Upsell (pós limpa/rating)
 *   10 = Diagnóstico concluído
 *   11 = Serviço concluído
 *
 * Educativos (IDs 12-16):
 *   12 = Convite jornada
 *   13 = Novo módulo disponível
 *   14 = Lembrete de módulo
 *   15 = Avanço de fase
 *   16 = Dica de crédito semanal
 */

export const TEMPLATE_IDS = {
  // Transactional
  WELCOME: 2,
  PASSWORD_RESET: 3,
  PURCHASE_CONFIRMED: 4,
  CART_ABANDONED: 5,
  PIX_GENERATED: 6,
  PIX_EXPIRED: 7,
  FOLLOWUP: 8,
  UPSELL: 9,
  DIAGNOSIS_COMPLETED: 10,
  SERVICE_COMPLETED: 11,

  // Educativos
  JOURNEY_INVITE: 12,
  MODULE_AVAILABLE: 13,
  MODULE_REMINDER: 14,
  PHASE_ADVANCE: 15,
  CREDIT_TIP: 16,
};

/**
 * Build template params for each email type.
 * Returns the params object expected by the Brevo template.
 */
export function buildParams(templateKey, data = {}) {
  const base = {
    FIRSTNAME: data.nome || data.name || "",
  };

  switch (templateKey) {
    case "WELCOME":
      return { ...base };

    case "PASSWORD_RESET":
      return { ...base, RESET_LINK: data.resetLink || data.reset_link || "" };

    case "PURCHASE_CONFIRMED":
      return { ...base, PRODUTO: data.produto || "", VALOR: data.valor || "" };

    case "CART_ABANDONED":
      return { ...base, PRODUTO: data.produto || "" };

    case "PIX_GENERATED":
      return { ...base, VALOR: data.valor || "", PIX_CODE: data.pixCode || "", EXPIRATION: data.expiration || "" };

    case "PIX_EXPIRED":
      return { ...base, VALOR: data.valor || "" };

    case "FOLLOWUP":
      return { ...base };

    case "UPSELL":
      return { ...base, SERVICO_CONCLUIDO: data.servicoConcluido || "" };

    case "DIAGNOSIS_COMPLETED":
      return { ...base, RESULTADO: data.resultado || "", SCORE: String(data.score || "") };

    case "SERVICE_COMPLETED":
      return { ...base, SERVICO: data.servico || "" };

    case "JOURNEY_INVITE":
      return { ...base };

    case "MODULE_AVAILABLE":
      return { ...base, MODULO_NOME: data.moduloNome || "", MODULO_DESC: data.moduloDesc || "" };

    case "MODULE_REMINDER":
      return { ...base, MODULO_NOME: data.moduloNome || "" };

    case "PHASE_ADVANCE":
      return { ...base, FASE_ANTERIOR: data.faseAnterior || "", NOVA_FASE: data.novaFase || "", CP_GANHOS: data.cpGanhos || "" };

    case "CREDIT_TIP":
      return {
        ...base,
        DICA_NUMERO: data.dicaNumero || "",
        DICA_TITULO: data.dicaTitulo || "",
        DICA_INTRO: data.dicaIntro || "",
        DICA_CONTEUDO: data.dicaConteudo || "",
        DICA_PRATICA: data.dicaPratica || "",
      };

    default:
      return base;
  }
}
