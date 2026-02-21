import { config } from '../config.js';

/**
 * Compliance output filter — v2 with text normalization.
 * Scans agent responses for banned keywords before sending.
 */

/**
 * Normalize text: lowercase, remove accents, strip extra spaces.
 */
function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BANNED_PATTERNS = [
  // Price mentions
  /R\$\s*\d/i,
  /\d+\s*reais/i,
  /custa\s/i,
  /pre[cç]o\s*(é|e|de|do|da)/i,
  /valor\s*(é|e|de|do|da)\s*R?\$?\s*\d/i,
  /\d+\s*parcelas?\s*de/i,
  /pagamento\s*de\s*R?\$?\s*\d/i,

  // Score/result promises
  /garantimos/i,
  /garantia de resultado/i,
  /prometemos/i,
  /seu score vai subir/i,
  /aumentar? (seu )?score/i,
  /score garantido/i,
  /cr[eé]dito aprovado/i,
  /aprova[cç][aã]o garantida/i,
  /vamos (limpar|resolver|aprovar)/i,

  // Código bug prevention
  /\bc[oó]digo\b/i,
  /\bcode\b/i,
  /\btoken\b/i,
  /\bhash\b/i,
  /\bsystem prompt\b/i,
  /\bmetadata\b/i,

  // Sale imperatives
  /\bcompre\b/i,
  /\bpague\b/i,
  /\badquira\b/i,

  // Identity leaks
  /\batendente\b/i,
  /\bhumano\b/i,
  /\bcloser\b/i,
  /\brobo\b/i,
  /\bintelig[eê]ncia artificial\b/i,
  /\bIA\b(?=\s|$)/,
  /\bchatbot\b/i,
  /vou te conectar/i,
  /vou te transferir/i,
  /outro profissional/i,

  // Urgency
  /[uú]ltimas vagas/i,
  /pre[cç]o promocional/i,
  /s[oó] hoje/i,
  /oferta.*tempo limitado/i,
  /promo[cç][aã]o.*acaba/i,

  // Technical terms that shouldn't leak
  /\bthin file\b/i,
  /\bperfil fino\b/i,
  /\bSCR\b/,
  /\bBacen\b/i,
  /\bwebhook\b/i,
  /\bAPI\b(?=\s|$)/,
];

// Normalized patterns (checked against accent-stripped text)
const NORMALIZED_BANNED = [
  'garantia de aprovacao',
  'score garantido',
  'credito aprovado',
  'aprovacao garantida',
  'vamos aprovar',
  'nos garantimos',
  'sistema prompt',
  'inteligencia artificial',
];

/**
 * Fix any incorrect/shortened site links to the correct URL.
 */
export function fixSiteLinks(text) {
  const correctUrl = config.site.url;
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

  // Check regex patterns against original text
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(text)) {
      violations.push(pattern.source);
    }
  }

  // Check normalized patterns against accent-stripped text
  const normalizedText = normalize(text);
  for (const phrase of NORMALIZED_BANNED) {
    if (normalizedText.includes(phrase)) {
      violations.push(`normalized:${phrase}`);
    }
  }

  return {
    clean: violations.length === 0,
    violations: [...new Set(violations)],
  };
}

/**
 * Build a correction instruction when filter catches violations.
 */
export function buildCorrectionInstruction(violations) {
  return `COMPLIANCE VIOLATION DETECTED. Your previous response contained banned content (patterns: ${violations.join(', ')}). Rewrite your response following these rules:
- NEVER mention prices in R$ or reais
- NEVER promise score increase or credit approval
- NEVER use sale imperatives (compre, pague, adquira)
- NEVER mention "atendente", "humano", "closer", "robô", "IA", "chatbot"
- NEVER mention "código", "code", "token", "hash", "metadata"
- NEVER mention technical terms (Bacen, SCR, thin file, webhook, API)
- NEVER use artificial urgency
Rewrite the SAME message intent but compliant.`;
}
