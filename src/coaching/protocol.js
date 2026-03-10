/**
 * Coaching Protocol — Igor Emmanuel - Mudanca de Vida
 *
 * Automated accountability system with scheduled prompts and AI-powered responses.
 * Sends MC (morning), NC (night), RS (weekly review), RM (monthly review)
 * and tracks responses + patterns.
 *
 * Group JID : configured via COACHING_GROUP_JID env var
 * Bot token : Augusto (COACHING_BOT_TOKEN or fallback)
 */

import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { sendText, getTokenForWid } from '../quepasa/client.js';
import { trackApiCost } from '../monitoring/cost-tracker.js';
import { emit, setStatus } from '../os/emitter.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const COACHING_GROUP_JID = process.env.COACHING_GROUP_JID || '';

/** Lazy token resolver — called after initTokenMapping() has populated the map. */
function getBotToken() {
  return process.env.COACHING_BOT_TOKEN || getTokenForWid('5571936180654:') || config.quepasa.botToken;
}

/** Igor's phone identifiers (to detect his responses in the group). */
const IGOR_PHONES = new Set([
  '5511932145806', '11932145806',
  '212287801561248', '212287801561248@lid',
]);

/** Claude client for generating contextual responses. */
const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ─── System prompt for contextual responses ──────────────────────────────────

export const COACHING_SYSTEM_PROMPT = `Voce e o coach de accountability do Igor Emmanuel no grupo "Mudanca de Vida".

CONTEXTO DO IGOR:
- Arquetipos: Governante + Mago + Amante
- Marte em Gemeos: guerreiro intelectual, usa a palavra como arma, dispersa facil
- Padrao de sabotagem: procrastinacao sofisticada (otimizar, consumir conteudo, refinar processos ANTES de executar)
- Maior bloqueio: evitar confrontos e conversas dificeis que envolvem poder ou dinheiro
- Framework: PDA (Perceber > Decidir > Agir)
- Gargalo: excesso de preparo como fuga da acao desconfortavel

REGRAS ABSOLUTAS:
1. Maximo 3-4 linhas. Impacto vem da precisao, nao do volume.
2. NUNCA motivacao generica. Cada resposta e especifica ao que ele escreveu.
3. NUNCA permita justificar inacao com "estou planejando/organizando/estudando". Confronte: "Isso e acao ou preparacao?"
4. Se mencionar segundo negocio antes do primeiro faturar consistente 3 meses: "O primeiro ja roda com consistencia? Segundo veiculo antes disso e fuga."
5. Se acao de caixa for vaga (organizar funil, analisar dados): "Isso coloca dinheiro no caixa em 24-48h? Se nao, qual acao coloca?"
6. Se confronto estiver vazio/generico: "Qual e a conversa que voce esta evitando faz mais de 3 dias?"
7. Se ele responder "nao me diminui em nada" na noturna: "Certeza? Onde voce poderia ter cobrado mais, posicionado mais firme, ou dito nao?"
8. Se perguntar algo fora do protocolo, responda breve e redirecione: "Boa questao. Agora: a acao de caixa de hoje ja foi?"
9. Sem emojis. Sem markdown pesado. Texto limpo.

FRASES DE REFERENCIA (use quando apropriado, nao repita):
- "Percebeu. Decidiu. Agiu? Se parou no 'decidiu', esta no limbo."
- "Protocolo sem execucao e diario bonito. E diario nao paga conta."
- "O Governante lidera um reino de cada vez."
- "Onde tem preparacao demais, tem confronto de menos."
- "A sombra nao some quando voce ignora. Ela pilota."`;

// ─── Date helpers (BRT = UTC-3) ──────────────────────────────────────────────

function getBRTDate() {
  const now = new Date();
  return new Date(now.getTime() - 3 * 60 * 60 * 1000);
}

function formatDateBR(date) {
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const y = date.getUTCFullYear();
  return `${d}/${m}/${y}`;
}

function getWeekRange() {
  const brt = getBRTDate();
  const day = brt.getUTCDay(); // 0=Sun
  const diffToMon = day === 0 ? 6 : day - 1;
  const monday = new Date(brt);
  monday.setUTCDate(brt.getUTCDate() - diffToMon);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { start: formatDateBR(monday), end: formatDateBR(sunday) };
}

function getMonthYear() {
  const brt = getBRTDate();
  const months = ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  return `${months[brt.getUTCMonth()]}/${brt.getUTCFullYear()}`;
}

function getTodayStr() {
  const brt = getBRTDate();
  return brt.toISOString().slice(0, 10); // YYYY-MM-DD
}

function isFirstSundayOfMonth() {
  const brt = getBRTDate();
  return brt.getUTCDay() === 0 && brt.getUTCDate() <= 7;
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function markSent(date, type) {
  await db.query(
    `INSERT INTO coaching_entries (date, type, sent_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (date, type) DO NOTHING`,
    [date, type]
  );
}

async function getEntry(date, type) {
  const { rows } = await db.query(
    'SELECT * FROM coaching_entries WHERE date = $1 AND type = $2',
    [date, type]
  );
  return rows[0] || null;
}

async function markResponded(date, type, responseText, agentReply) {
  await db.query(
    `UPDATE coaching_entries
     SET responded_at = NOW(), response_text = $3, agent_reply = $4
     WHERE date = $1 AND type = $2`,
    [date, type, responseText, agentReply]
  );
}

async function savePattern(date, patternText) {
  // Deduplicate: only one pattern per day
  const { rows } = await db.query(
    'SELECT id FROM coaching_patterns WHERE date = $1',
    [date]
  );
  if (rows.length > 0) {
    await db.query(
      'UPDATE coaching_patterns SET pattern_text = $2 WHERE date = $1',
      [date, patternText]
    );
  } else {
    await db.query(
      'INSERT INTO coaching_patterns (date, pattern_text) VALUES ($1, $2)',
      [date, patternText]
    );
  }
}

async function getWeeklyScore() {
  const brt = getBRTDate();
  const day = brt.getUTCDay();
  const diffToMon = day === 0 ? 6 : day - 1;
  const monday = new Date(brt);
  monday.setUTCDate(brt.getUTCDate() - diffToMon);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);

  const monStr = monday.toISOString().slice(0, 10);
  const sunStr = sunday.toISOString().slice(0, 10);

  // Count days where BOTH mc AND nc were responded
  const { rows } = await db.query(
    `SELECT date, COUNT(DISTINCT type) as types_responded
     FROM coaching_entries
     WHERE date >= $1 AND date <= $2
       AND type IN ('mc', 'nc')
       AND responded_at IS NOT NULL
     GROUP BY date
     HAVING COUNT(DISTINCT type) = 2`,
    [monStr, sunStr]
  );
  return rows.length;
}

async function getRecentPatterns(days = 7) {
  const { rows } = await db.query(
    `SELECT pattern_text, date FROM coaching_patterns
     WHERE date >= CURRENT_DATE - $1::int
     ORDER BY date DESC`,
    [days]
  );
  return rows;
}

async function getUnansweredStreak() {
  // Count consecutive days (from today backwards) where at least one entry was sent but not answered
  const today = getTodayStr();
  let streak = 0;

  for (let i = 0; i < 14; i++) {
    const d = new Date(getBRTDate());
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().slice(0, 10);

    const { rows } = await db.query(
      `SELECT COUNT(*) as total,
              COUNT(CASE WHEN responded_at IS NOT NULL THEN 1 END) as answered
       FROM coaching_entries
       WHERE date = $1 AND type IN ('mc', 'nc') AND sent_at IS NOT NULL`,
      [dateStr]
    );

    const row = rows[0];
    if (parseInt(row.total) === 0) break; // No entries this day — end of streak window
    if (parseInt(row.answered) > 0) break; // Answered at least one — streak broken
    streak++;
  }

  return streak;
}

// ─── Scheduled messages ─────────────────────────────────────────────────────

async function sendMC() {
  if (!COACHING_GROUP_JID) return;
  const today = getTodayStr();
  const existing = await getEntry(today, 'mc');
  if (existing?.sent_at) return; // Already sent today

  const date = formatDateBR(getBRTDate());
  const text = `[MC] Morning Command — ${date}

Antes de abrir qualquer rede social, responde:

1) Acao de caixa antes das 9h:
2) Confronto/conversa dificil de hoje:

Regra: se nao fez as duas antes do almoco, o dia ficou devendo.`;

  await sendText(COACHING_GROUP_JID, text, getBotToken());
  await markSent(today, 'mc');
  console.log('[Coaching] MC sent');
  await emit('coaching.checkin_sent', 'coaching', { type: 'morning' });
  await setStatus('coaching', 'online');
}

async function sendNC() {
  if (!COACHING_GROUP_JID) return;
  const today = getTodayStr();
  const existing = await getEntry(today, 'nc');
  if (existing?.sent_at) return;

  // Check if MC was answered
  const mc = await getEntry(today, 'mc');
  const mcNote = (!mc?.responded_at)
    ? '\n\nObs: MC de hoje ficou sem resposta.'
    : '';

  const date = formatDateBR(getBRTDate());
  const text = `[NC] Night Check — ${date}

3) Onde eu me diminui hoje?

Responde com honestidade. Sem justificativa. O padrao so aparece quando voce anota.${mcNote}`;

  await sendText(COACHING_GROUP_JID, text, getBotToken());
  await markSent(today, 'nc');
  console.log('[Coaching] NC sent');
  await emit('coaching.checkin_sent', 'coaching', { type: 'night' });
  await setStatus('coaching', 'online');
}

async function sendRS() {
  if (!COACHING_GROUP_JID) return;
  const today = getTodayStr();
  const existing = await getEntry(today, 'rs');
  if (existing?.sent_at) return;

  const score = await getWeeklyScore();
  const week = getWeekRange();
  const patterns = await getRecentPatterns(7);
  const patternNote = patterns.length > 0
    ? `\nPadroes que apareceram essa semana: ${[...new Set(patterns.map(p => p.pattern_text.substring(0, 80)))].slice(0, 3).join('; ')}`
    : '';

  const text = `[RS] Revisao Semanal — Semana de ${week.start} a ${week.end}

Score parcial: ${score}/7 dias com MC + NC completos.${patternNote}

1) Score: quantos dias fiz MC + NC completos? ___/7
2) Padrao dominante da semana (releia suas respostas da pergunta 3):
3) Quantas mensagens de ativacao de rede enviei? Meta: 3
4) Uma acao de alavanca que fiz (treinar gerente, documentar, automatizar):

Meta minima: 5/7 dias. Abaixo disso, simplifica. Nao adiciona.`;

  await sendText(COACHING_GROUP_JID, text, getBotToken());
  await markSent(today, 'rs');
  console.log('[Coaching] RS sent');
  await emit('coaching.checkin_sent', 'coaching', { type: 'weekly' });
  await setStatus('coaching', 'online');
}

async function sendRM() {
  if (!COACHING_GROUP_JID) return;
  const today = getTodayStr();
  const existing = await getEntry(today, 'rm');
  if (existing?.sent_at) return;

  const monthYear = getMonthYear();

  const text = `[RM] Revisao Mensal — ${monthYear}

1) IDENTIDADE: Quem eu precisei me tornar esse mes? Quem preciso me tornar no proximo?
2) PERMISSAO: Meu teto subiu ou estou no mesmo lugar? Onde me senti "em divida" por crescer?
3) CAIXA: Faturamento vs. meta. Numero. Qual acao evitei que teria feito diferenca?
4) SOMBRA: Qual padrao de sabotagem mais apareceu nos checks noturnos?
5) PRE-QUEDA: Algo na vida/relacoes esta sinalizando sabotagem antes de uma subida?
6) DECISAO DO MES: UMA decisao estrategica para o proximo mes. Nao tres. Uma.`;

  await sendText(COACHING_GROUP_JID, text, getBotToken());
  await markSent(today, 'rm');
  console.log('[Coaching] RM sent');
  await emit('coaching.checkin_sent', 'coaching', { type: 'monthly' });
  await setStatus('coaching', 'online');
}

// ─── Follow-up nudges ────────────────────────────────────────────────────────

async function checkMCTimeout() {
  if (!COACHING_GROUP_JID) return;
  const today = getTodayStr();
  const mc = await getEntry(today, 'mc');
  if (mc?.sent_at && !mc?.responded_at) {
    await sendText(
      COACHING_GROUP_JID,
      'Silencio e resposta. O dia esta rodando sem comando. O que te travou?',
      getBotToken()
    );
    console.log('[Coaching] MC timeout nudge sent');
  }
}

async function checkNCTimeout() {
  if (!COACHING_GROUP_JID) return;
  const today = getTodayStr();
  const nc = await getEntry(today, 'nc');
  if (nc?.sent_at && !nc?.responded_at) {
    await sendText(
      COACHING_GROUP_JID,
      'O check noturno e onde o padrao aparece. Pular e a sombra vencendo.',
      getBotToken()
    );
    console.log('[Coaching] NC timeout nudge sent');
  }
}

async function checkMultiDayGap() {
  if (!COACHING_GROUP_JID) return;
  const streak = await getUnansweredStreak();
  if (streak >= 2) {
    await sendText(
      COACHING_GROUP_JID,
      `Sumiu do protocolo faz ${streak} dias. Nao e julgamento, e dado. O que aconteceu? O padrao de fuga comecou quando?`,
      getBotToken()
    );
    console.log(`[Coaching] Multi-day gap nudge sent (${streak} days)`);
  }
}

// ─── Response handler ────────────────────────────────────────────────────────

/**
 * Detect if Igor's message is a protocol response via explicit tags ONLY.
 * Returns 'mc', 'nc', 'rs', 'rm', or null.
 * Keyword-based detection is deferred to the pending-entry fallback logic.
 */
function detectResponseType(text) {
  const lower = text.toLowerCase().trim();

  // Only match explicit tag prefixes to avoid false positives
  if (lower.startsWith('[mc]')) return 'mc';
  if (lower.startsWith('[nc]')) return 'nc';
  if (lower.startsWith('[rs]')) return 'rs';
  if (lower.startsWith('[rm]')) return 'rm';

  return null;
}

/**
 * Generate a contextual AI response to Igor's protocol entry.
 */
async function generateResponse(type, responseText, context) {
  const typeLabels = { mc: 'Morning Command', nc: 'Night Check', rs: 'Revisao Semanal', rm: 'Revisao Mensal' };

  let contextInfo = `Tipo: ${typeLabels[type] || type}\n`;

  if (type === 'nc') {
    const patterns = await getRecentPatterns(7);
    const repeated = patterns.filter(p =>
      p.pattern_text.toLowerCase().includes(responseText.toLowerCase().substring(0, 30))
    );
    if (repeated.length >= 3) {
      contextInfo += `ALERTA: Padrao similar apareceu ${repeated.length} vezes essa semana. Aponte isso.\n`;
    }
  }

  if (type === 'rs') {
    const score = await getWeeklyScore();
    contextInfo += `Score semanal calculado: ${score}/7\n`;
  }

  if (context.unansweredDays > 0) {
    contextInfo += `Dias sem resposta recente: ${context.unansweredDays}\n`;
  }

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 200,
      temperature: 0.5,
      system: COACHING_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `${contextInfo}\nResposta do Igor:\n${responseText}`,
      }],
    });

    trackApiCost({
      provider: 'anthropic',
      model: config.anthropic.model,
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
      endpoint: 'coaching',
    }).catch(() => {});

    return response.content[0]?.text?.trim() || '';
  } catch (err) {
    console.error('[Coaching] AI response error:', err.message);
    return '';
  }
}

/**
 * Handle an incoming message from the coaching group.
 * Only processes messages from Igor.
 */
export async function handleCoachingMessage(msg) {
  if (!COACHING_GROUP_JID) return;

  const chatId = msg.chat?.id || msg.chatId || msg.source || '';
  if (chatId !== COACHING_GROUP_JID) return;

  // Identify sender
  const senderLid = msg.chat?.lid || msg.lid || '';
  const senderPhone = msg.chat?.phone?.replace(/^\+/, '') || msg.from || '';
  const senderId = senderLid || senderPhone;
  const stripped = senderId.replace(/@.*$/, '');

  // Only respond to Igor
  const isIgor = IGOR_PHONES.has(stripped) ||
    IGOR_PHONES.has(stripped.replace(/^55/, '')) ||
    IGOR_PHONES.has('55' + stripped);

  if (!isIgor) return;

  const text = msg.text || msg.body || msg.message?.text || msg.message?.conversation || '';
  if (!text || text.length < 3) return;

  // Reject attempts to add more questions to the protocol
  const lower = text.toLowerCase();
  if (lower.includes('adicionar') || lower.includes('nova pergunta') || lower.includes('mais uma pergunta')) {
    await sendText(
      COACHING_GROUP_JID,
      'O protocolo tem 3 perguntas por um motivo. Adicionar complexidade e o padrao. Executa essas primeiro.',
      getBotToken()
    );
    return;
  }

  console.log(`[Coaching] Igor responded: ${text.substring(0, 100)}`);

  const today = getTodayStr();

  // Detect what type of response this is (explicit tags only)
  let type = detectResponseType(text);
  let entryDate = today;

  // If no explicit tag, infer from pending entries (oldest unanswered first)
  if (!type) {
    const mc = await getEntry(today, 'mc');
    const nc = await getEntry(today, 'nc');

    if (mc?.sent_at && !mc?.responded_at) {
      type = 'mc';
      entryDate = today;
    } else if (nc?.sent_at && !nc?.responded_at) {
      type = 'nc';
      entryDate = today;
    }

    // Check for pending RS/RM (look back a few days for weekly/monthly)
    if (!type) {
      for (let i = 0; i < 3; i++) {
        const d = new Date(getBRTDate());
        d.setUTCDate(d.getUTCDate() - i);
        const dateStr = d.toISOString().slice(0, 10);
        const rs = await getEntry(dateStr, 'rs');
        if (rs?.sent_at && !rs?.responded_at) { type = 'rs'; entryDate = dateStr; break; }
        const rm = await getEntry(dateStr, 'rm');
        if (rm?.sent_at && !rm?.responded_at) { type = 'rm'; entryDate = dateStr; break; }
      }
    }
  }

  // If still no type detected, treat as off-protocol message
  if (!type) {
    const redirect = 'Boa questao. Agora: a acao de caixa de hoje ja foi?';
    await sendText(COACHING_GROUP_JID, redirect, getBotToken());
    return;
  }

  // Save the response
  await markResponded(entryDate, type, text, '');

  // Save pattern for night checks (question 3)
  if (type === 'nc') {
    await savePattern(entryDate, text.substring(0, 500));
  }

  // Generate contextual response
  const streak = await getUnansweredStreak();
  const reply = await generateResponse(type, text, { unansweredDays: streak });

  if (reply) {
    await sendText(COACHING_GROUP_JID, reply, getBotToken());
    await db.query(
      'UPDATE coaching_entries SET agent_reply = $3 WHERE date = $1 AND type = $2',
      [entryDate, type, reply]
    );
    console.log(`[Coaching] Replied to ${type}: ${reply.substring(0, 100)}`);
  }
}

// ─── Cron scheduler ──────────────────────────────────────────────────────────

/**
 * Start all coaching protocol cron jobs.
 * Schedules: MC 07:30 BRT (Mon-Sat), NC 21:00 BRT, RS Sunday 20:00 BRT, RM 1st Sunday 10:00 BRT
 * Plus timeout nudges.
 */
export function startCoachingScheduler() {
  if (!COACHING_GROUP_JID) {
    console.log('[Coaching] COACHING_GROUP_JID not set, scheduler disabled');
    return;
  }

  // MC: 07:30 BRT = 10:30 UTC, Mon-Sat only → cron '30 10 * * 1-6'
  cron.schedule('30 10 * * 1-6', async () => {
    console.log('[Coaching] Cron: MC 07:30 BRT');
    await sendMC().catch(err => console.error('[Coaching] MC error:', err.message));
  });

  // NC: 21:00 BRT = 00:00 UTC (next day), every day → cron '0 0 * * *'
  cron.schedule('0 0 * * *', async () => {
    console.log('[Coaching] Cron: NC 21:00 BRT');
    await sendNC().catch(err => console.error('[Coaching] NC error:', err.message));
  });

  // RS: Sunday 20:00 BRT = Sunday 23:00 UTC → cron '0 23 * * 0'
  cron.schedule('0 23 * * 0', async () => {
    console.log('[Coaching] Cron: RS Sunday 20:00 BRT');
    await sendRS().catch(err => console.error('[Coaching] RS error:', err.message));
  });

  // RM: First Sunday of month 10:00 BRT = 13:00 UTC → cron '0 13 * * 0'
  cron.schedule('0 13 * * 0', async () => {
    if (isFirstSundayOfMonth()) {
      console.log('[Coaching] Cron: RM 1st Sunday 10:00 BRT');
      await sendRM().catch(err => console.error('[Coaching] RM error:', err.message));
    }
  });

  // MC timeout nudge: 10:00 BRT = 13:00 UTC, Mon-Sat → cron '0 13 * * 1-6'
  cron.schedule('0 13 * * 1-6', async () => {
    await checkMCTimeout().catch(err => console.error('[Coaching] MC timeout error:', err.message));
  });

  // NC timeout nudge: 22:00 BRT = 01:00 UTC (next day) → cron '0 1 * * *'
  cron.schedule('0 1 * * *', async () => {
    await checkNCTimeout().catch(err => console.error('[Coaching] NC timeout error:', err.message));
  });

  // Multi-day gap check: 12:00 BRT daily = 15:00 UTC → cron '0 15 * * *'
  cron.schedule('0 15 * * *', async () => {
    await checkMultiDayGap().catch(err => console.error('[Coaching] Gap check error:', err.message));
  });

  console.log('[Coaching] Scheduler registered: MC 07:30 (Seg-Sab), NC 21:00, RS Dom 20:00, RM 1o Dom 10:00 (BRT)');
}
