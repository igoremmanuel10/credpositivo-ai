/**
 * Agenda Manager — CredPositivo ADM Group
 *
 * Handles scheduling, reminders, and daily agenda summaries
 * in the CredPositivo ADM WhatsApp group.
 *
 * Commands:
 *   /agenda or "agenda de hoje"  → today's events
 *   /amanha or "agenda de amanha" → tomorrow's events
 *   /semana or "agenda da semana" → week's events
 *   /marcar or "agendar ..."     → create event (AI-parsed)
 *   /cancelar <id>               → cancel event
 *
 * Crons:
 *   - Every minute: check for 30-min-ahead reminders
 *   - Daily 8:00 BRT: send day's agenda summary
 */

import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { sendText, getTokenForWid } from '../quepasa/client.js';
import { transcribeAudio } from '../audio/transcribe.js';
import { trackApiCost } from '../monitoring/cost-tracker.js';
import { sendAlexReportNow, runAlexCheckCycle } from '../devops/alex.js';
import { formatDailyReport } from '../devops/formatter.js';
import { getRecentErrors, getErrorPatterns } from '../devops/error-interceptor.js';
import { generateManagerReport } from '../manager/luan.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const ADM_GROUP_JID = config.agenda.admGroupJid;

/** Augusto bot phone — used to resolve the correct token for sending. */
const AUGUSTO_PHONE = '5571936180654';

/** Resolve Augusto's token at runtime (after initTokenMapping). */
function getAugustoToken() {
  return getTokenForWid(`${AUGUSTO_PHONE}:`);
}

/**
 * Team member registry.
 * Maps sender identifiers (phone, LID) to display names.
 * Same pattern as expense tracker's PARTNER_MAP.
 */
const TEAM_MAP = {
  // Igor Emmanuel
  '5511932145806':       'Igor Emmanuel',
  '11932145806':         'Igor Emmanuel',
  '212287801561248':     'Igor Emmanuel',
  '212287801561248@lid': 'Igor Emmanuel',

  // Igor Arcanjo
  '557187700120':        'Igor Arcanjo',
  '7187700120':          'Igor Arcanjo',
  '106008550572122':     'Igor Arcanjo',
  '106008550572122@lid': 'Igor Arcanjo',

  // Raimundo / Teodoro Neto
  '557191234115':        'Raimundo',
  '7191234115':          'Raimundo',
  '149056923934932':     'Raimundo',
  '149056923934932@lid': 'Raimundo',
};

/** Bot phones — never treated as team member. */
const BOT_PHONES = new Set(['5571936180654', '71936180654', '5521971364221', '21971364221']);

/** Day-of-week names in Portuguese. */
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

// ─── Anthropic client ─────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTeamMember(rawId) {
  if (!rawId) return null;
  const stripped = rawId.replace(/@.*$/, '');
  if (TEAM_MAP[stripped]) return TEAM_MAP[stripped];
  if (TEAM_MAP[rawId]) return TEAM_MAP[rawId];
  const withoutPrefix = stripped.replace(/^55/, '');
  if (TEAM_MAP[withoutPrefix]) return TEAM_MAP[withoutPrefix];
  if (TEAM_MAP['55' + stripped]) return TEAM_MAP['55' + stripped];
  return null;
}

function isBotSender(rawId) {
  const stripped = rawId?.replace(/@.*$/, '') || '';
  return BOT_PHONES.has(stripped) || BOT_PHONES.has('55' + stripped);
}

/** Convert a Date to BRT components (server runs in UTC). */
function toBRT(date) {
  const brt = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  return {
    year: brt.getUTCFullYear(),
    month: brt.getUTCMonth(),
    day: brt.getUTCDate(),
    hours: brt.getUTCHours(),
    minutes: brt.getUTCMinutes(),
    dayOfWeek: brt.getUTCDay(),
  };
}

/** Format Date as "DD/MM/YYYY" in BRT. */
function formatDate(date) {
  const b = toBRT(date);
  const d = String(b.day).padStart(2, '0');
  const m = String(b.month + 1).padStart(2, '0');
  return `${d}/${m}/${b.year}`;
}

/** Format Date as "DD/MM" in BRT. */
function formatDateShort(date) {
  const b = toBRT(date);
  const d = String(b.day).padStart(2, '0');
  const m = String(b.month + 1).padStart(2, '0');
  return `${d}/${m}`;
}

/** Format time as "HH:MM" in BRT. */
function formatTime(date) {
  const b = toBRT(date);
  const h = String(b.hours).padStart(2, '0');
  const min = String(b.minutes).padStart(2, '0');
  return `${h}:${min}`;
}

/** Get current BRT date. */
function nowBRT() {
  const now = new Date();
  return new Date(now.getTime() - 3 * 60 * 60 * 1000);
}

/** Get today's date string in YYYY-MM-DD (BRT). */
function todayBRT() {
  const brt = nowBRT();
  return brt.toISOString().slice(0, 10);
}

/** Get tomorrow's date string in YYYY-MM-DD (BRT). */
function tomorrowBRT() {
  const brt = nowBRT();
  brt.setUTCDate(brt.getUTCDate() + 1);
  return brt.toISOString().slice(0, 10);
}

// ─── AI Parsing ───────────────────────────────────────────────────────────────

/**
 * Use Claude Haiku to extract scheduling data from natural language.
 *
 * @param {string} text - user message
 * @param {string} senderName - who sent it
 * @returns {Promise<object|null>} parsed event data or null
 */
async function parseScheduleIntent(text, senderName) {
  const today = todayBRT();

  const systemPrompt = `Voce e um parser de agendamentos. Extraia dados de eventos de mensagens em portugues.
Hoje e ${today}. Responda APENAS com JSON valido (sem markdown):
{
  "is_schedule": true/false,
  "title": "<titulo do evento>",
  "date": "<YYYY-MM-DD>",
  "time": "<HH:MM no formato 24h>",
  "attendees": ["<nomes das pessoas envolvidas>"],
  "description": "<descricao adicional ou null>"
}

Regras:
- is_schedule = false se a mensagem nao descreve um agendamento
- Se disser "amanha", calcule a data correta a partir de hoje
- Se disser "segunda", "terca" etc, calcule a proxima ocorrencia
- Se nao especificar horario, use null para time
- Se nao especificar participantes alem do remetente, attendees = []
- Interprete "call", "reuniao", "meet", "encontro", "consulta" como eventos
- O remetente e "${senderName}" — nao inclua ele em attendees`;

  try {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 200,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: text }],
    });

    trackApiCost({
      provider: 'anthropic',
      model: config.anthropic.model,
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
      endpoint: 'agenda-parse',
    }).catch(() => {});

    const raw = response.content[0]?.text?.trim() || '';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const data = JSON.parse(cleaned);

    if (!data.is_schedule) return null;
    if (!data.title) return null;

    return data;
  } catch (err) {
    console.error('[Agenda] AI parsing error:', err.message);
    return null;
  }
}

// ─── Database ─────────────────────────────────────────────────────────────────

async function createEvent({ groupJid, title, description, scheduledAt, createdByName, createdByPhone, attendees, messageId }) {
  try {
    const { rows } = await db.query(
      `INSERT INTO group_events
         (group_jid, title, description, scheduled_at, created_by_name, created_by_phone, attendees, message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [groupJid, title, description || null, scheduledAt, createdByName, createdByPhone || null, JSON.stringify(attendees || []), messageId || null]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[Agenda] createEvent error:', err.message);
    return null;
  }
}

async function cancelEvent(eventId, groupJid) {
  try {
    const { rows } = await db.query(
      `UPDATE group_events SET cancelled = TRUE WHERE id = $1 AND group_jid = $2 AND cancelled = FALSE RETURNING *`,
      [eventId, groupJid]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[Agenda] cancelEvent error:', err.message);
    return null;
  }
}

async function getEventsForDate(groupJid, dateStr) {
  const { rows } = await db.query(
    `SELECT id, title, scheduled_at, created_by_name, attendees
     FROM group_events
     WHERE group_jid = $1
       AND cancelled = FALSE
       AND DATE(scheduled_at AT TIME ZONE 'America/Sao_Paulo') = $2
     ORDER BY scheduled_at ASC`,
    [groupJid, dateStr]
  );
  return rows;
}

async function getEventsForWeek(groupJid) {
  const today = todayBRT();
  const brt = nowBRT();
  const endOfWeek = new Date(brt);
  endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 7);
  const endStr = endOfWeek.toISOString().slice(0, 10);

  const { rows } = await db.query(
    `SELECT id, title, scheduled_at, created_by_name, attendees
     FROM group_events
     WHERE group_jid = $1
       AND cancelled = FALSE
       AND DATE(scheduled_at AT TIME ZONE 'America/Sao_Paulo') >= $2
       AND DATE(scheduled_at AT TIME ZONE 'America/Sao_Paulo') <= $3
     ORDER BY scheduled_at ASC`,
    [groupJid, today, endStr]
  );
  return rows;
}

async function getPendingReminders() {
  const now = new Date();
  const in31min = new Date(now.getTime() + 31 * 60 * 1000);

  const { rows } = await db.query(
    `SELECT id, group_jid, title, scheduled_at, created_by_name, attendees
     FROM group_events
     WHERE cancelled = FALSE
       AND reminder_sent = FALSE
       AND scheduled_at > $1
       AND scheduled_at <= $2
     ORDER BY scheduled_at ASC`,
    [now.toISOString(), in31min.toISOString()]
  );
  return rows;
}

async function markReminderSent(eventId) {
  await db.query('UPDATE group_events SET reminder_sent = TRUE WHERE id = $1', [eventId]);
}

// ─── Message Formatting ──────────────────────────────────────────────────────

function formatEventConfirmation(event) {
  const dt = new Date(event.scheduled_at);
  const dia = DIAS[toBRT(dt).dayOfWeek];
  const lines = [
    'Agendado!',
    '',
    event.title,
    `Data: ${formatDate(dt)} (${dia}) as ${formatTime(dt)}`,
    `Agendado por: ${event.created_by_name || 'Desconhecido'}`,
  ];

  const attendees = typeof event.attendees === 'string' ? JSON.parse(event.attendees) : event.attendees;
  if (attendees && attendees.length > 0) {
    lines.push(`Participantes: ${attendees.join(', ')}`);
  }

  lines.push(`\nID: #${event.id}`);
  return lines.join('\n');
}

function formatDailyAgenda(events, dateStr) {
  const dt = new Date(dateStr + 'T12:00:00');
  const header = `Bom dia! Agenda de hoje (${formatDateShort(dt)}):`;

  if (events.length === 0) {
    return `${header}\n\nNenhum compromisso agendado.\nBom trabalho!`;
  }

  const lines = [header, ''];
  for (const ev of events) {
    const time = formatTime(new Date(ev.scheduled_at));
    const who = ev.created_by_name ? ` (${ev.created_by_name})` : '';
    lines.push(`${time} - ${ev.title}${who}`);
  }
  lines.push(`\n${events.length} compromisso${events.length > 1 ? 's' : ''} hoje.`);
  return lines.join('\n');
}

function formatWeekAgenda(events) {
  if (events.length === 0) {
    return 'Agenda da semana:\n\nNenhum compromisso nos proximos 7 dias.';
  }

  const lines = ['Agenda da semana:', ''];
  let currentDate = '';

  for (const ev of events) {
    const dt = new Date(ev.scheduled_at);
    const dateKey = dt.toISOString().slice(0, 10);
    if (dateKey !== currentDate) {
      if (currentDate) lines.push('');
      const dia = DIAS[toBRT(dt).dayOfWeek];
      lines.push(`*${formatDateShort(dt)} (${dia})*`);
      currentDate = dateKey;
    }
    const time = formatTime(dt);
    const who = ev.created_by_name ? ` (${ev.created_by_name})` : '';
    lines.push(`  ${time} - ${ev.title}${who}`);
  }

  lines.push(`\n${events.length} compromisso${events.length > 1 ? 's' : ''} na semana.`);
  return lines.join('\n');
}

function formatReminder(event) {
  const dt = new Date(event.scheduled_at);
  return `Lembrete! Daqui a 30 minutos:\n\n${event.title} - ${formatTime(dt)}`;
}

// ─── Command Detection ───────────────────────────────────────────────────────

function detectCommand(text) {
  const lower = text.toLowerCase().trim();

  // Cancel
  if (lower.startsWith('/cancelar') || lower.startsWith('cancelar #') || lower.startsWith('cancelar evento')) {
    const match = text.match(/#?(\d+)/);
    return { command: 'cancel', eventId: match ? parseInt(match[1]) : null };
  }

  // Week
  if (lower === '/semana' || lower.includes('agenda da semana') || lower.includes('agenda semanal')) {
    return { command: 'week' };
  }

  // Tomorrow
  if (lower === '/amanha' || lower === '/amanhã' || lower.includes('agenda de amanha') || lower.includes('agenda de amanhã')) {
    return { command: 'tomorrow' };
  }

  // Today
  if (lower === '/agenda' || lower === 'agenda' || lower.includes('agenda de hoje') || lower === '/hoje') {
    return { command: 'today' };
  }

  // Schedule — explicit commands
  if (lower.startsWith('/marcar') || lower.startsWith('/agendar')) {
    return { command: 'schedule', text: text.replace(/^\/(marcar|agendar)\s*/i, '').trim() };
  }

  // Schedule — natural language detection
  const scheduleKeywords = ['agendar', 'marcar', 'marca ', 'agenda ', 'bora marcar', 'vamos marcar', 'reuniao', 'reunião', 'call com', 'call as', 'call às', 'encontro com', 'meeting'];
  const hasScheduleIntent = scheduleKeywords.some(kw => lower.includes(kw));
  // Avoid false positives: "agenda de hoje" is a query, not a schedule
  const isQuery = lower.includes('agenda de') || lower === 'agenda' || lower.includes('agenda semanal');

  if (hasScheduleIntent && !isQuery) {
    return { command: 'schedule', text };
  }


  // Admin report commands
  if (lower.match(/^#(alex|devops?)/)) {
    return { command: 'alex_report' };
  }
  if (lower.match(/^#(luan|gerente|relatorio)/)) {
    return { command: 'luan_report' };
  }

  return null;
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function handleTodayCommand() {
  const events = await getEventsForDate(ADM_GROUP_JID, todayBRT());
  return formatDailyAgenda(events, todayBRT());
}

async function handleTomorrowCommand() {
  const tmr = tomorrowBRT();
  const events = await getEventsForDate(ADM_GROUP_JID, tmr);
  const dt = new Date(tmr + 'T12:00:00');

  if (events.length === 0) {
    return `Agenda de amanha (${formatDateShort(dt)}):\n\nNenhum compromisso agendado.`;
  }

  const lines = [`Agenda de amanha (${formatDateShort(dt)}):`, ''];
  for (const ev of events) {
    const time = formatTime(new Date(ev.scheduled_at));
    const who = ev.created_by_name ? ` (${ev.created_by_name})` : '';
    lines.push(`${time} - ${ev.title}${who}`);
  }
  lines.push(`\n${events.length} compromisso${events.length > 1 ? 's' : ''}.`);
  return lines.join('\n');
}

async function handleWeekCommand() {
  const events = await getEventsForWeek(ADM_GROUP_JID);
  return formatWeekAgenda(events);
}

async function handleCancelCommand(eventId) {
  if (!eventId) return 'Informe o ID do evento. Ex: /cancelar 5';
  const cancelled = await cancelEvent(eventId, ADM_GROUP_JID);
  if (!cancelled) return `Evento #${eventId} nao encontrado ou ja cancelado.`;
  return `Evento cancelado: #${cancelled.id} - ${cancelled.title}`;
}

async function handleScheduleCommand(text, senderName, senderPhone, msgId) {
  if (!text) return 'Descreva o evento. Ex: /marcar reuniao com Igor amanha as 15h';

  const parsed = await parseScheduleIntent(text, senderName);
  if (!parsed) return 'Nao consegui entender o agendamento. Tente algo como:\n"agendar reuniao com Joao amanha as 15h"';

  if (!parsed.date) return 'Nao consegui identificar a data. Tente especificar: "amanha as 15h" ou "dia 25/02 as 10h"';
  if (!parsed.time) return 'Nao consegui identificar o horario. Tente: "as 15h" ou "as 10:30"';

  // Build scheduled_at in BRT (store as UTC)
  const scheduledBRT = new Date(`${parsed.date}T${parsed.time}:00-03:00`);
  if (isNaN(scheduledBRT.getTime())) return 'Data/hora invalida. Tente novamente.';

  // Don't allow scheduling in the past
  if (scheduledBRT < new Date()) return 'Nao e possivel agendar no passado. Informe uma data futura.';

  const event = await createEvent({
    groupJid: ADM_GROUP_JID,
    title: parsed.title,
    description: parsed.description,
    scheduledAt: scheduledBRT.toISOString(),
    createdByName: senderName,
    createdByPhone: senderPhone,
    attendees: parsed.attendees || [],
    messageId: msgId,
  });

  if (!event) return 'Erro ao salvar o evento. Tente novamente.';
  return formatEventConfirmation(event);
}

// ─── Main Message Handler ─────────────────────────────────────────────────────

/**
 * Process an incoming message from the ADM group.
 *
 * @param {object} msg - raw Quepasa webhook payload
 */
export async function handleAdmGroupMessage(msg) {
  if (!ADM_GROUP_JID) return;

  const chatId = msg.chat?.id || msg.chatId || msg.source || '';
  if (chatId !== ADM_GROUP_JID) return;

  // Determine sender (in group messages, sender is in msg.participant, not msg.chat)
  const senderLid = msg.participant?.id || msg.chat?.lid || msg.lid || '';
  const senderPhone = msg.participant?.phone?.replace(/^\+/, '') || msg.chat?.phone?.replace(/^\+/, '') || msg.from || '';
  const senderId = senderLid || senderPhone;

  // Ignore bot's own messages
  if (isBotSender(senderPhone) || isBotSender(senderLid)) return;

  let text = msg.text || msg.body || msg.message?.text || msg.message?.conversation || '';

  // Transcribe audio messages in the ADM group
  if (!text && (msg.type === 'audio' || msg.type === 'ptt') && msg.id) {
    try {
      console.log(`[Agenda] Audio in ADM group, transcribing ${msg.id}...`);
      text = await transcribeAudio(msg.id, getAugustoToken());
      if (!text) { console.log('[Agenda] Audio transcription empty, ignoring'); return; }
      console.log(`[Agenda] Transcribed: ${text.substring(0, 200)}`);
    } catch (err) {
      console.error('[Agenda] Audio transcription failed:', err.message);
      return;
    }
  }

  if (!text) return;

  const pushName = msg.participant?.title || msg.senderName || msg.pushName || '';
  const memberName = resolveTeamMember(senderLid) || resolveTeamMember(senderPhone) || pushName || 'Desconhecido';
  const msgId = msg.id || null;

  console.log(`[Agenda] Group message from ${memberName} (${senderId}): ${text.substring(0, 100)}`);

  // Detect command
  const cmd = detectCommand(text);
  if (!cmd) return; // Not a command, ignore silently

  let response;
  try {
    switch (cmd.command) {
      case 'today':
        response = await handleTodayCommand();
        break;
      case 'tomorrow':
        response = await handleTomorrowCommand();
        break;
      case 'week':
        response = await handleWeekCommand();
        break;
      case 'cancel':
        response = await handleCancelCommand(cmd.eventId);
        break;
      case 'schedule':
        response = await handleScheduleCommand(cmd.text || text, memberName, senderPhone, msgId);
        break;
      case 'alex_report':
        console.log('[Agenda] Admin report command: #alex from ' + memberName);
        try {
          const health = await runAlexCheckCycle();
          const errors24h = getRecentErrors(24 * 60);
          const reportText = formatDailyReport(
            { overall: health.overall, services: health.services },
            errors24h, [],
            health.services?.find(s => s.service === 'api_costs')?.details || null,
            health.diagnosis || 'Sistema verificado sob demanda.'
          );
          response = reportText;
        } catch (err) {
          response = 'Erro Alex: ' + err.message;
        }
        break;
      case 'luan_report':
        console.log('[Agenda] Admin report command: #luan from ' + memberName);
        try {
          const { whatsappMessages } = await generateManagerReport({ reportType: 'on_demand', days: 7 });
          for (const msg of whatsappMessages) {
            await sendText(ADM_GROUP_JID, msg, getAugustoToken());
          }
          response = null;
        } catch (err) {
          response = 'Erro Luan: ' + err.message;
        }
        break;
      default:
        return;
    }
  } catch (err) {
    console.error('[Agenda] Command handler error:', err.message);
    response = 'Erro ao processar comando. Tente novamente.';
  }

  if (response) {
    try {
      await sendText(ADM_GROUP_JID, response, getAugustoToken());
      console.log(`[Agenda] Response sent to group: ${response.substring(0, 80)}`);
    } catch (err) {
      console.error('[Agenda] Failed to send response:', err.message);
    }
  }
}

// ─── Cron: 30-minute Reminders ───────────────────────────────────────────────

async function checkReminders() {
  if (!ADM_GROUP_JID) return;

  try {
    const pending = await getPendingReminders();
    for (const event of pending) {
      const msg = formatReminder(event);
      await sendText(event.group_jid, msg, getAugustoToken());
      await markReminderSent(event.id);
      console.log(`[Agenda] Reminder sent for event #${event.id}: ${event.title}`);
    }
  } catch (err) {
    console.error('[Agenda] Reminder check error:', err.message);
  }
}

// ─── Cron: Daily Agenda Summary ──────────────────────────────────────────────

async function sendDailyAgenda() {
  if (!ADM_GROUP_JID) return;

  try {
    const events = await getEventsForDate(ADM_GROUP_JID, todayBRT());
    const msg = formatDailyAgenda(events, todayBRT());
    await sendText(ADM_GROUP_JID, msg, getAugustoToken());
    console.log(`[Agenda] Daily agenda sent: ${events.length} events`);
  } catch (err) {
    console.error('[Agenda] Daily agenda error:', err.message);
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Start the agenda cron jobs.
 * Register this in src/index.js alongside the other schedulers.
 */
export function startAgendaScheduler() {
  if (!config.agenda.enabled || !ADM_GROUP_JID) {
    console.log('[Agenda] Disabled (AGENDA_ENABLED=false or ADM_GROUP_JID not set)');
    return;
  }

  // Every minute: check for 30-min-ahead reminders
  cron.schedule('* * * * *', checkReminders);

  // Daily 8:00 BRT = 11:00 UTC, Monday-Saturday (no Sunday)
  cron.schedule('0 11 * * 1-6', sendDailyAgenda);

  console.log('[Agenda] Cron registered: reminders (every min) + daily agenda (8h BRT seg-sab)');
}
