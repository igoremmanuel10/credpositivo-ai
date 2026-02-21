import { config } from '../config.js';

/**
 * Compliance output filter.
 * Scans agent responses for banned keywords before sending.
 */

const BANNED_PATTERNS = [
  // Price mentions
  /R\$\s*\d/i,
  /\d+\s*reais/i,
  /custa\s/i,
  /pre[cç]o\s*(é|e|de)/i,

  // Score/result promises
  /garantimos/i,
  /garantia de resultado/i,
  /prometemos/i,
  /seu score vai subir/i,
  /aumentar? (seu )?score/i,
  /score garantido/i,
  /cr[eé]dito aprovado/i,
  /aprova[cç][aã]o garantida/i,

  // Código bug prevention
  /\bc[oó]digo\b/i,
  /\bcode\b/i,
  /\btoken\b/i,
  /\bhash\b/i,

  // Sale imperatives
  /\bcompre\b/i,
  /\bpague\b/i,

  // Identity leaks
  /\bespecialista\b(?!.*cr[eé]dito)/i, // "especialista" alone (not "especialista de crédito")
  /\batendente\b/i,
  /\bhumano\b/i,
  /\bcloser\b/i,
  /vou te conectar/i,
  /vou te transferir/i,
  /outro profissional/i,

  // Conversation ending (relaxed — agent CAN say "fico por aqui" or "quando precisar")
  // Removed: "última mensagem", "vou encerrar", "encerrando" — agent needs to signal closure gracefully

  // Urgency
  /[uú]ltimas vagas/i,
  /pre[cç]o promocional/i,
  /s[oó] hoje/i,
  /oferta.*tempo limitado/i,
];

/**
 * Fix any incorrect/shortened site links to the correct URL.
 * GPT-4o-mini tends to shorten URLs — this catches and fixes it.
 */
export function fixSiteLinks(text) {
  const correctUrl = config.site.url; // https://www.credpositivo.com/cadastro

  // Replace any variation of credpositivo links with the correct one
  return text.replace(
    /https?:\/\/(www\.)?credpositivo\.com(\.br)?(\/\S*)?/gi,
    correctUrl
  );
}

/**
 * Check if a message contains banned content.
 * Returns { clean: boolean, violations: string[] }
 */
export function filterOutput(text) {
  const violations = [];

  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(text)) {
      violations.push(pattern.source);
    }
  }

  return {
    clean: violations.length === 0,
    violations,
  };
}

/**
 * Build a correction instruction when filter catches violations.
 */
export function buildCorrectionInstruction(violations) {
  return `COMPLIANCE VIOLATION DETECTED. Your previous response contained banned content (patterns: ${violations.join(', ')}). Rewrite your response following these rules:
- NEVER mention prices in R$ or reais
- NEVER promise score increase or credit approval
- NEVER use sale imperatives (compre, pague)
- NEVER mention "especialista", "atendente", "humano", "closer"
- NEVER mention "código", "code", "token", "hash"
- NEVER use artificial urgency
Rewrite the SAME message intent but compliant.`;
}
