/**
 * Expense Tracker — Financeiro | Grupo (CredPositivo)
 *
 * Listens to messages from the financial WhatsApp group and extracts
 * expense data using AI. Stores results in PostgreSQL and sends
 * formatted summaries on demand or on a weekly cron schedule.
 *
 * Group JID : 120363407635437895@g.us
 * Bot token : Paulo SDR (6953640a-8240-4168-8006-944cdf6b9102)
 */

import OpenAI from 'openai';
import cron from 'node-cron';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { sendText, downloadMedia } from '../quepasa/client.js';
import { trackApiCost } from '../monitoring/cost-tracker.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const FINANCEIRO_GROUP_JID = '120363407635437895@g.us';

/** Bot token used to send messages to the group (Paulo SDR). */
const PAULO_TOKEN = '6953640a-8240-4168-8006-944cdf6b9102';

/**
 * Partner registry.
 * Maps every known identifier (phone number, LID) to a canonical display name.
 * Add new identifiers here if a partner changes device / LID.
 */
const PARTNER_MAP = {
  // Igor Emmanuel
  '5511932145806':          'Igor Emmanuel',
  '11932145806':            'Igor Emmanuel',
  '212287801561248':        'Igor Emmanuel',
  '212287801561248@lid':    'Igor Emmanuel',

  // Igor Arcanjo
  '557187700120':           'Igor Arcanjo',
  '7187700120':             'Igor Arcanjo',
  '106008550572122':        'Igor Arcanjo',
  '106008550572122@lid':    'Igor Arcanjo',

  // Raimundo / Teodoro Neto
  '557191234115':           'Raimundo',
  '7191234115':             'Raimundo',
  '149056923934932':        'Raimundo',
  '149056923934932@lid':    'Raimundo',
};

/** Paulo SDR phone — this is the bot itself, never counted as a partner. */
const BOT_PHONES = new Set(['5521971364221', '21971364221']);

/** Words that trigger an on-demand summary. */
const SUMMARY_TRIGGER_WORDS = ['resumo', 'quanto gastamos', 'total', 'gastos'];

// ─── OpenAI client ─────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: config.openai.apiKey, dangerouslyAllowBrowser: true });

// ─── Partner resolution ────────────────────────────────────────────────────────

/**
 * Resolve the partner name from a raw sender identifier.
 * Accepts phone numbers (with or without country code) and LID strings.
 *
 * @param {string} rawId - phone number or LID from Quepasa msg
 * @returns {string|null} canonical partner name, or null if not recognised
 */
function resolvePartnerName(rawId) {
  if (!rawId) return null;

  // Strip @lid / @s.whatsapp.net suffix for map lookup
  const stripped = rawId.replace(/@.*$/, '');

  if (PARTNER_MAP[stripped])        return PARTNER_MAP[stripped];
  if (PARTNER_MAP[rawId])           return PARTNER_MAP[rawId];

  // Try stripping leading country-code duplicates (e.g. "55" prefix variants)
  const withoutPrefix = stripped.replace(/^55/, '');
  if (PARTNER_MAP[withoutPrefix])   return PARTNER_MAP[withoutPrefix];
  if (PARTNER_MAP['55' + stripped]) return PARTNER_MAP['55' + stripped];

  return null;
}

/**
 * Returns true if the sender is the Paulo bot itself.
 */
function isBotSender(rawId) {
  const stripped = rawId?.replace(/@.*$/, '') || '';
  return BOT_PHONES.has(stripped) || BOT_PHONES.has('55' + stripped);
}

// ─── AI extraction ─────────────────────────────────────────────────────────────

/**
 * Use GPT-4o-mini to extract structured expense data from a text message.
 *
 * Returns null if the message does not describe an expense.
 *
 * @param {string} text - raw message text
 * @param {string} partnerName - sender's canonical name (for context)
 * @returns {Promise<{amount:number, description:string, category:string, date:string, confidence:string}|null>}
 */
async function extractExpenseFromText(text, partnerName) {
  const systemPrompt = `Você é um extrator de dados de gastos financeiros para uma empresa brasileira.
Analise a mensagem e extraia informações de despesas/gastos.

Responda APENAS com JSON válido no seguinte formato (sem markdown, sem texto extra):
{
  "is_expense": true/false,
  "amount": <número decimal em reais, ex: 97.50>,
  "description": "<descrição clara do gasto>",
  "category": "<uma das opções: marketing|infra|ferramenta|taxa|pagamento|outro>",
  "date": "<data no formato YYYY-MM-DD, ou null se não mencionada>",
  "confidence": "<high|medium|low>"
}

Regras:
- is_expense = false se a mensagem não descreve um gasto real (ex: perguntas, conversas, emojis soltos)
- Para valores: interprete "R$ 150", "150 reais", "150,00", "R$150" como 150.00
- Se a mensagem for ambígua mas parecer um gasto, use confidence = "medium"
- Se não conseguir extrair um valor numérico, is_expense = false
- category "infra" = servidor, domínio, hospedagem, cloud
- category "ferramenta" = SaaS, software, app, API
- category "taxa" = imposto, IOF, tarifa bancária, taxa de cartão
- category "pagamento" = pagamento a fornecedor, freelancer, serviço
- category "marketing" = anúncio, criativo, tráfego pago, influencer`;

  const userMessage = `Remetente: ${partnerName}\nMensagem: ${text}`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openai.model, // gpt-4o-mini
      max_tokens: 200,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    trackApiCost({
      provider: 'openai',
      model: config.openai.model,
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0,
      endpoint: 'chat',
    }).catch(() => {});

    const raw = response.choices[0]?.message?.content?.trim() || '';
    const data = JSON.parse(raw);

    if (!data.is_expense || !data.amount || isNaN(parseFloat(data.amount))) {
      return null;
    }

    return {
      amount: parseFloat(data.amount),
      description: data.description || text.substring(0, 200),
      category: data.category || 'outro',
      date: data.date || null,
      confidence: data.confidence || 'medium',
    };
  } catch (err) {
    console.error('[ExpenseTracker] Text extraction error:', err.message);
    return null;
  }
}

/**
 * Use GPT-4o Vision to extract expense data from a receipt/comprovante image.
 *
 * @param {string} base64Image - base64-encoded image
 * @param {string} mimeType - e.g. 'image/jpeg'
 * @param {string} partnerName - sender's canonical name
 * @returns {Promise<{amount:number, description:string, category:string, date:string, confidence:string}|null>}
 */
async function extractExpenseFromImage(base64Image, mimeType, partnerName) {
  const prompt = `Este é um comprovante de pagamento ou nota fiscal enviado por ${partnerName}.
Extraia as informações de gasto e responda APENAS com JSON válido (sem markdown):
{
  "is_expense": true/false,
  "amount": <valor total pago em reais como número decimal>,
  "description": "<descrição do que foi pago>",
  "category": "<marketing|infra|ferramenta|taxa|pagamento|outro>",
  "date": "<data no formato YYYY-MM-DD ou null>",
  "confidence": "<high|medium|low>"
}

Se não for um comprovante/gasto, retorne {"is_expense": false}.`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openai.visionModel, // gpt-4o
      max_tokens: 300,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
    });

    trackApiCost({
      provider: 'openai',
      model: config.openai.visionModel,
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0,
      endpoint: 'vision',
    }).catch(() => {});

    const raw = response.choices[0]?.message?.content?.trim() || '';

    // Strip markdown code fences if model wraps the response
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const data = JSON.parse(cleaned);

    if (!data.is_expense || !data.amount || isNaN(parseFloat(data.amount))) {
      return null;
    }

    return {
      amount: parseFloat(data.amount),
      description: data.description || 'Comprovante de pagamento',
      category: data.category || 'outro',
      date: data.date || null,
      confidence: data.confidence || 'medium',
    };
  } catch (err) {
    console.error('[ExpenseTracker] Image extraction error:', err.message);
    return null;
  }
}

// ─── Database helpers ──────────────────────────────────────────────────────────

/**
 * Persist an expense record. Silently ignores duplicate message IDs.
 *
 * @returns {Promise<object|null>} inserted row or null on duplicate/error
 */
async function saveExpense({
  groupJid,
  partnerName,
  partnerPhone,
  amount,
  description,
  category,
  receiptUrl,
  messageId,
  rawText,
  confidence,
  expenseDate,
}) {
  try {
    // Check for duplicate message_id first (partial unique index doesn't support ON CONFLICT)
    if (messageId) {
      const { rows: existing } = await db.query(
        'SELECT id FROM expenses WHERE message_id = $1', [messageId]
      );
      if (existing.length > 0) return null; // duplicate
    }

    const { rows } = await db.query(
      `INSERT INTO expenses
         (group_jid, partner_name, partner_phone, amount, description, category,
          receipt_url, message_id, raw_text, extraction_confidence, expense_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        groupJid,
        partnerName,
        partnerPhone || null,
        amount,
        description,
        category || 'outro',
        receiptUrl || null,
        messageId || null,
        rawText || null,
        confidence || 'high',
        expenseDate || new Date().toISOString().slice(0, 10),
      ]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[ExpenseTracker] saveExpense error:', err.message);
    return null;
  }
}

/**
 * Fetch all expenses for a group within a date range.
 *
 * @param {string} groupJid
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Promise<Array>}
 */
async function fetchExpenses(groupJid, startDate, endDate) {
  const { rows } = await db.query(
    `SELECT partner_name, amount, description, category, expense_date
     FROM expenses
     WHERE group_jid = $1
       AND expense_date >= $2
       AND expense_date <= $3
     ORDER BY partner_name, expense_date ASC, id ASC`,
    [groupJid, startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10)]
  );
  return rows;
}

// ─── Summary generation ────────────────────────────────────────────────────────

/**
 * Format a BRL amount: 1234.5 → "1.234,50"
 */
function formatBRL(amount) {
  return Number(amount).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format a Date as "DD/MM/YYYY".
 */
function formatDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}/${m}/${y}`;
}

/**
 * Generate a formatted expense summary for a given time period.
 *
 * @param {'week'|'month'|'custom'} period - period type
 * @param {Date} [customStart] - required when period === 'custom'
 * @param {Date} [customEnd]   - required when period === 'custom'
 * @returns {Promise<string>} WhatsApp-formatted message
 */
export async function generateSummary(period = 'week', customStart = null, customEnd = null) {
  let startDate;
  let endDate = new Date();

  if (period === 'week') {
    // Last 7 days
    startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
  } else if (period === 'month') {
    // Current calendar month
    startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  } else if (period === 'custom' && customStart && customEnd) {
    startDate = customStart;
    endDate = customEnd;
  } else {
    // Default: current week (Monday → today)
    startDate = new Date();
    const dayOfWeek = startDate.getDay(); // 0=Sun
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    startDate.setDate(startDate.getDate() - daysToMonday);
    startDate.setHours(0, 0, 0, 0);
  }

  const expenses = await fetchExpenses(FINANCEIRO_GROUP_JID, startDate, endDate);

  // Group by partner
  const byPartner = {};
  let grandTotal = 0;

  for (const row of expenses) {
    const name = row.partner_name;
    if (!byPartner[name]) byPartner[name] = { items: [], subtotal: 0 };
    byPartner[name].items.push(row);
    byPartner[name].subtotal += parseFloat(row.amount);
    grandTotal += parseFloat(row.amount);
  }

  // Build message
  const lines = [
    `*RESUMO FINANCEIRO - CredPositivo*`,
    `Periodo: ${formatDate(startDate)} a ${formatDate(endDate)}`,
    '',
  ];

  if (Object.keys(byPartner).length === 0) {
    lines.push('Nenhum gasto registrado neste periodo.');
  } else {
    // Canonical partner display order
    const ORDER = ['Igor Emmanuel', 'Igor Arcanjo', 'Raimundo'];
    const partners = [
      ...ORDER.filter(p => byPartner[p]),
      ...Object.keys(byPartner).filter(p => !ORDER.includes(p)),
    ];

    for (const partner of partners) {
      const { items, subtotal } = byPartner[partner];
      lines.push(`*${partner}*`);
      for (const item of items) {
        lines.push(`  - ${item.description} - R$ ${formatBRL(item.amount)}`);
      }
      lines.push(`  Subtotal: R$ ${formatBRL(subtotal)}`);
      lines.push('');
    }

    lines.push(`*TOTAL GERAL: R$ ${formatBRL(grandTotal)}*`);
  }

  return lines.join('\n');
}

// ─── On-demand summary handler ─────────────────────────────────────────────────

/**
 * Detect whether a message text is requesting a summary.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isSummaryRequest(text) {
  const lower = text.toLowerCase().trim();
  return SUMMARY_TRIGGER_WORDS.some(trigger => lower.includes(trigger));
}

/**
 * Handle an on-demand summary request from the group.
 * Detects time period keywords and sends the appropriate summary.
 *
 * @param {object} msg - Quepasa message object
 */
async function handleSummaryRequest(msg) {
  const text = (msg.text || msg.body || '').toLowerCase();

  let period = 'week';
  if (text.includes('mes') || text.includes('mês') || text.includes('mensal')) {
    period = 'month';
  }

  console.log(`[ExpenseTracker] Summary requested (period=${period})`);

  try {
    const summary = await generateSummary(period);
    await sendText(FINANCEIRO_GROUP_JID, summary, PAULO_TOKEN);
    console.log('[ExpenseTracker] Summary sent to group');
  } catch (err) {
    console.error('[ExpenseTracker] Failed to send summary:', err.message);
  }
}

// ─── Main message handler ──────────────────────────────────────────────────────

/**
 * Process an incoming group message.
 * - Ignores messages from the bot itself
 * - Routes summary requests to handleSummaryRequest()
 * - Extracts and saves expense data from partner messages
 *
 * @param {object} msg - raw Quepasa webhook payload
 */
export async function handleGroupMessage(msg) {
  const chatId = msg.chat?.id || msg.chatId || msg.source || '';

  // Safety guard: only process the Financeiro group
  if (chatId !== FINANCEIRO_GROUP_JID) return;

  // Determine sender identifiers (Quepasa may use LID or phone)
  const senderLid   = msg.chat?.lid || msg.lid || '';
  const senderPhone = msg.chat?.phone?.replace(/^\+/, '') || msg.from || '';
  const senderId    = senderLid || senderPhone;

  // Ignore messages from the Paulo bot itself
  if (isBotSender(senderPhone) || isBotSender(senderLid)) {
    console.log('[ExpenseTracker] Ignoring own message');
    return;
  }

  const msgType = msg.type || '';
  const text    = msg.text || msg.body || msg.message?.text || msg.message?.conversation || '';
  const msgId   = msg.id || null;

  console.log(`[ExpenseTracker] Group message from ${senderId} (type=${msgType}): ${text.substring(0, 100)}`);

  // ── Summary request ──────────────────────────────────────────────────────
  if (text && isSummaryRequest(text)) {
    await handleSummaryRequest(msg);
    return;
  }

  // ── Expense extraction ───────────────────────────────────────────────────

  // Resolve who sent this message
  const partnerName = resolvePartnerName(senderLid) || resolvePartnerName(senderPhone);

  if (!partnerName) {
    // Message from someone we don't track (e.g. a random participant) — ignore silently
    console.log(`[ExpenseTracker] Unrecognised sender ${senderId}, skipping`);
    return;
  }

  let extracted = null;
  let receiptUrl = null;

  // ── Text message ─────────────────────────────────────────────────────────
  if (text && msgType !== 'image') {
    extracted = await extractExpenseFromText(text, partnerName);
  }

  // ── Image / comprovante ──────────────────────────────────────────────────
  if (msgType === 'image' && msgId) {
    try {
      console.log(`[ExpenseTracker] Downloading image ${msgId} for receipt analysis`);
      const buffer   = await downloadMedia(msgId, PAULO_TOKEN);
      const base64   = buffer.toString('base64');
      const mimeType = msg.attachment?.mime || msg.mimetype || 'image/jpeg';

      extracted  = await extractExpenseFromImage(base64, mimeType, partnerName);
      receiptUrl = `quepasa-media:${msgId}`; // reference for audit trail

      // If caption also present and image analysis returned nothing, try caption
      if (!extracted && text) {
        extracted = await extractExpenseFromText(text, partnerName);
      }
    } catch (err) {
      console.error('[ExpenseTracker] Image download/analysis error:', err.message);
      // Fall back to caption if available
      if (text) {
        extracted = await extractExpenseFromText(text, partnerName);
      }
    }
  }

  if (!extracted) {
    console.log(`[ExpenseTracker] No expense data found in message from ${partnerName}`);
    return;
  }

  // ── Persist ──────────────────────────────────────────────────────────────
  const saved = await saveExpense({
    groupJid:    FINANCEIRO_GROUP_JID,
    partnerName,
    partnerPhone: senderPhone || null,
    amount:       extracted.amount,
    description:  extracted.description,
    category:     extracted.category,
    receiptUrl,
    messageId:    msgId,
    rawText:      text || null,
    confidence:   extracted.confidence,
    expenseDate:  extracted.date || new Date().toISOString().slice(0, 10),
  });

  if (saved) {
    console.log(
      `[ExpenseTracker] Saved expense: ${partnerName} — R$ ${extracted.amount} — ${extracted.description}`
    );
  } else {
    console.log('[ExpenseTracker] Expense already recorded (duplicate message_id), skipped');
  }
}

// ─── Weekly cron summary ───────────────────────────────────────────────────────

/**
 * Send the weekly expense summary to the Financeiro group.
 * Called by the cron scheduler every Monday at 09:00 BRT (12:00 UTC).
 */
export async function sendWeeklySummary() {
  console.log('[ExpenseTracker] Sending weekly summary to Financeiro group...');

  try {
    // Weekly summary: Monday 00:00 → Sunday 23:59 of the PREVIOUS week
    const now       = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...

    // Compute last Monday
    const daysToLastMonday = dayOfWeek === 1 ? 7 : (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
    const lastMonday       = new Date(now);
    lastMonday.setDate(now.getDate() - daysToLastMonday);
    lastMonday.setHours(0, 0, 0, 0);

    // Compute last Sunday
    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastMonday.getDate() + 6);
    lastSunday.setHours(23, 59, 59, 999);

    const summary = await generateSummary('custom', lastMonday, lastSunday);
    await sendText(FINANCEIRO_GROUP_JID, summary, PAULO_TOKEN);
    console.log('[ExpenseTracker] Weekly summary sent successfully');
  } catch (err) {
    console.error('[ExpenseTracker] Failed to send weekly summary:', err.message);
  }
}

// ─── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Start the expense tracker cron jobs.
 * Register this in src/index.js alongside the other schedulers.
 *
 * Schedule: Monday 09:00 BRT = Monday 12:00 UTC
 * Cron:     0 12 * * 1
 */
export function startExpenseScheduler() {
  // Monday 09:00 BRT = 12:00 UTC
  cron.schedule('0 12 * * 1', async () => {
    console.log('[ExpenseTracker] Cron Monday 09h BRT - sending weekly summary');
    await sendWeeklySummary();
  });

  console.log('[ExpenseTracker] Cron registered: weekly summary every Monday 09:00 BRT');
}
