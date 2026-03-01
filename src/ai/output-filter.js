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
  /desconto.*expira/i,
  /vagas? limitadas?/i,

  // Technical terms that shouldn't leak
  /\bthin file\b/i,
  /\bperfil fino\b/i,
  /\bSCR\b/,
  /\bBacen\b/i,
  /\bwebhook\b/i,
  /\bAPI\b(?=\s|$)/,
  /\bpgvector\b/i,
  /\bembedding\b/i,
  /\bprompt\b/i,
  /\bpipeline\b/i,

  // Evasion patterns (price in disguised forms)
  /investimento\s*(de|é|e)\s*apenas/i,
  /por\s+apenas\s+\d/i,
  /somente\s+\d+\s*x/i,
  /s[oó]\s+\d+\s*reais/i,
  /\d+\s*x\s*de\s*R?\$?\s*\d/i,
  /taxa\s*(de|é|e)\s*R?\$?\s*\d/i,

  // CPF/data solicitation
  /me\s+(passa|envia|manda)\s+(seu|o)\s+CPF/i,
  /preciso\s+do\s+seu\s+CPF/i,
  /dados\s+banc[aá]rios/i,
  /n[uú]mero\s+do\s+(cart[aã]o|cart[aã]o)/i,

  // False authority claims
  /somos\s+(regulados|certificados|autorizados)/i,
  /parceria\s+(oficial|exclusiva)\s+com\s+(serasa|spc|boa\s+vista)/i,
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
  'aumento de score',
  'aumentar seu score',
  'subir o score',
  'score vai aumentar',
  'limpar seu nome em',
  'aprovacao de credito',
  'cartao garantido',
  'credito garantido',
  'serasa vai',
  'spc vai',
  'rating bancario',
  'perfil bancario',
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
// Price-related patterns (allowed in phase 3+ when offer is expected)
const PRICE_PATTERNS = new Set([
  'R\\$\\s*\\d',
  '\\d+\\s*reais',
  'custa\\s',
  'pre[c\xE7]o\\s*(\xE9|e|de|do|da)',
  'valor\\s*(\xE9|e|de|do|da)\\s*R?\\$?\\s*\\d',
  '\\d+\\s*parcelas?\\s*de',
  'pagamento\\s*de\\s*R?\\$?\\s*\\d',
  'investimento\\s*(de|\xE9|e)\\s*apenas',
  'por\\s+apenas\\s+\\d',
  'somente\\s+\\d+\\s*x',
  's[o\xF3]\\s+\\d+\\s*reais',
  '\\d+\\s*x\\s*de\\s*R?\\$?\\s*\\d',
  'taxa\\s*(de|\xE9|e)\\s*R?\\$?\\s*\\d',
]);

export function filterOutput(text, phase = 0) {
  const violations = [];
  const allowPrice = phase >= 3;

  // Check regex patterns against original text
  for (const pattern of BANNED_PATTERNS) {
    // Skip price patterns in phase 3+ (offer phase)
    if (allowPrice && PRICE_PATTERNS.has(pattern.source)) {
      continue;
    }
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

/**
 * Clean text for WhatsApp delivery:
 * - Strip markdown bold/italic/code formatting
 * - Remove ALL emojis (broken or not)
 */
export function cleanForWhatsApp(text) {
  let cleaned = text;

  // Strip markdown bold (**text** or __text__)
  cleaned = cleaned.replace(/\*\*(.+?)\*\*/g, '$1');
  cleaned = cleaned.replace(/__(.+?)__/g, '$1');

  // Strip markdown italic (*text* but not contractions like "it's")
  cleaned = cleaned.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '$1');

  // Strip markdown code
  cleaned = cleaned.replace(/`([^`]+?)`/g, '$1');

  // Strip markdown headers
  cleaned = cleaned.replace(/^#{1,3}\s+/gm, '');

  // Remove ALL emoji characters (comprehensive Unicode ranges)
  cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}]/gu, '');
  cleaned = cleaned.replace(/[\u{1F300}-\u{1F5FF}]/gu, '');
  cleaned = cleaned.replace(/[\u{1F680}-\u{1F6FF}]/gu, '');
  cleaned = cleaned.replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '');
  cleaned = cleaned.replace(/[\u{2600}-\u{26FF}]/gu, '');
  cleaned = cleaned.replace(/[\u{2700}-\u{27BF}]/gu, '');
  cleaned = cleaned.replace(/[\u{FE00}-\u{FE0F}]/gu, '');
  cleaned = cleaned.replace(/[\u{200D}]/gu, '');
  cleaned = cleaned.replace(/[\u{20E3}]/gu, '');
  cleaned = cleaned.replace(/[\u{E0020}-\u{E007F}]/gu, '');
  cleaned = cleaned.replace(/[\u{1F900}-\u{1F9FF}]/gu, '');
  cleaned = cleaned.replace(/[\u{1FA00}-\u{1FA6F}]/gu, '');
  cleaned = cleaned.replace(/[\u{1FA70}-\u{1FAFF}]/gu, '');
  cleaned = cleaned.replace(/[\u{231A}-\u{231B}]/gu, '');
  cleaned = cleaned.replace(/[\u{23E9}-\u{23FA}]/gu, '');
  cleaned = cleaned.replace(/[\u{25AA}-\u{25FE}]/gu, '');
  cleaned = cleaned.replace(/[\u{2614}-\u{2615}]/gu, '');
  cleaned = cleaned.replace(/[\u{2648}-\u{2653}]/gu, '');
  cleaned = cleaned.replace(/[\u{2934}-\u{2935}]/gu, '');
  cleaned = cleaned.replace(/[\u{2B05}-\u{2B07}]/gu, '');
  cleaned = cleaned.replace(/[\u{2B1B}-\u{2B1C}]/gu, '');
  cleaned = cleaned.replace(/[\u{2B50}]/gu, '');
  cleaned = cleaned.replace(/[\u{2B55}]/gu, '');
  cleaned = cleaned.replace(/[✅❌👇👆👉✓✗☑☒⭐🌟💡🔥🎯🚀💰📊📈📉🏆💪🤝🙏❤️💙💚🔑🔗📍📎✨🎉🎊🛑⚠️✋🤔🏠🏦💳📱💻🔎📞📝🎁🔴🟢🟡]/gu, '');

  // Clean double spaces
  cleaned = cleaned.replace(/  +/g, ' ').trim();

  return cleaned;
}
