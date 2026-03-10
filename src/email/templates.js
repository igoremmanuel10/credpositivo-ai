/**
 * Email Template IDs — mapped to Brevo template IDs.
 * IDs must match exactly what's configured in the Brevo dashboard.
 *
 * Funnel (IDs 1-21):
 *   1-7   = Nivel A (Critico)
 *   8-14  = Nivel B (Atencao)
 *   15-21 = Nivel C (Preventivo)
 *
 * Transactional (IDs 22-26):
 *   22 = Boas-vindas
 *   23 = Recuperacao de senha
 *   24 = Compra aprovada
 *   25 = Pix gerado
 *   26 = Compra pendente (carrinho abandonado)
 */

export const TEMPLATE_IDS = {
  // Transactional
  WELCOME: 22,
  PASSWORD_RESET: 23,
  PURCHASE_CONFIRMED: 24,
  PIX_GENERATED: 25,
  CART_ABANDONED: 26,
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

    case "PIX_GENERATED":
      return { ...base, VALOR: data.valor || "", PIX_CODE: data.pixCode || "", EXPIRATION: data.expiration || "" };

    case "CART_ABANDONED":
      return { ...base, PRODUTO: data.produto || "" };

    default:
      return base;
  }
}
