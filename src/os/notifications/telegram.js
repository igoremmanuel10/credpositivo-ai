/**
 * @file src/os/notifications/telegram.js
 * @description Telegram notification module for the AI OS.
 *
 * Subscribes to the EventBus and forwards alerts to a Telegram bot using the
 * Telegram Bot API (plain HTTP — no external library required, Node 18+ fetch).
 *
 * Configuration
 * ─────────────
 *   TELEGRAM_BOT_TOKEN   Bot token from @BotFather
 *   TELEGRAM_CHAT_ID     Default chat/group ID to send messages to
 *
 * Redis keys
 * ──────────
 *   os:notifications:settings   JSON blob with full notification config.
 *
 * Settings schema (stored in Redis)
 * ──────────────────────────────────
 *   {
 *     enabled:          boolean          — master switch
 *     chatIds:          string[]         — list of chat IDs to notify
 *     quietHoursStart:  "HH:MM"          — local time (timezone below)
 *     quietHoursEnd:    "HH:MM"          — local time
 *     timezone:         string           — IANA timezone, e.g. "America/Sao_Paulo"
 *     events: {                          — per-event-type toggle
 *       "workflow.alert":      boolean,
 *       "workflow.escalation": boolean,
 *       "workflow.recovery":   boolean,
 *       "agent.error":         boolean,
 *       "alex.health_check":   boolean,
 *       "os.boot":             boolean
 *     }
 *   }
 *
 * Message formatting
 * ──────────────────
 *   Messages are sent with parse_mode=Markdown.  All user-supplied strings are
 *   escaped before insertion so Markdown special characters cannot break the
 *   message format.
 *
 * Quiet hours
 * ───────────
 *   When the current time (in the configured timezone) falls within
 *   [quietHoursStart, quietHoursEnd) the notification is silently dropped —
 *   except for events whose severity is "critical" (workflow.escalation,
 *   alex.health_check=CRITICO), which are always delivered.
 */

import Redis from 'ioredis';
import 'dotenv/config';
import { subscribeAll } from '../kernel/event-bus.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SETTINGS_KEY = 'os:notifications:settings';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Events that bypass quiet-hours suppression. */
const CRITICAL_EVENT_TYPES = new Set([
  'workflow.escalation',
  'alex.health_check', // only when overall=CRITICO — checked inside formatMessage
]);

// ─── Default settings ─────────────────────────────────────────────────────────

/** @type {NotificationSettings} */
const DEFAULT_SETTINGS = {
  enabled: true,
  chatIds: process.env.TELEGRAM_CHAT_ID ? [process.env.TELEGRAM_CHAT_ID] : [],
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',
  timezone: 'America/Sao_Paulo',
  events: {
    'workflow.alert': true,
    'workflow.escalation': true,
    'workflow.recovery': true,
    'agent.error': true,
    'alex.health_check': true,
    'os.boot': true,
  },
};

// ─── Redis ────────────────────────────────────────────────────────────────────

/** @type {Redis | null} */
let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
    });
    redisClient.on('error', (err) => {
      console.error('[Telegram] Redis error:', err.message);
    });
  }
  return redisClient;
}

// ─── Runtime state ────────────────────────────────────────────────────────────

/** Unsubscribe handle returned by subscribeAll(). */
let unsubscribeHandle = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a Telegram message to one or more chat IDs.
 *
 * Uses parse_mode=Markdown. Pass raw Markdown — the helper escapes dynamic
 * values before they reach this function, so the top-level text is trusted.
 *
 * @param {string} text      - Markdown-formatted message text
 * @param {string} [chatId]  - Override recipient chat ID. When omitted the
 *                             function reads chatIds from the current settings.
 * @returns {Promise<void>}
 */
export async function sendTelegram(text, chatId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('[Telegram] TELEGRAM_BOT_TOKEN not set — message not sent.');
    return;
  }

  // Resolve the list of chat IDs to send to.
  let targets;
  if (chatId) {
    targets = [chatId];
  } else {
    const settings = await getNotificationSettings();
    targets = settings.chatIds?.length
      ? settings.chatIds
      : process.env.TELEGRAM_CHAT_ID
        ? [process.env.TELEGRAM_CHAT_ID]
        : [];
  }

  if (targets.length === 0) {
    console.warn('[Telegram] No chat IDs configured — message not sent.');
    return;
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;

  await Promise.allSettled(
    targets.map(async (id) => {
      try {
        const body = JSON.stringify({
          chat_id: id,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          // Abort after 10 seconds to avoid hanging the event loop
          signal: AbortSignal.timeout(10_000),
        });

        if (!response.ok) {
          const payload = await response.text().catch(() => '(no body)');
          console.error(
            `[Telegram] API error for chat ${id}: HTTP ${response.status} — ${payload}`
          );
        } else {
          console.log(`[Telegram] Message sent to chat ${id}`);
        }
      } catch (err) {
        console.error(`[Telegram] Failed to send to chat ${id}:`, err.message);
      }
    })
  );
}

/**
 * Start the Telegram notification listener.
 *
 * Subscribes to all EventBus events and dispatches Telegram messages based on
 * the settings stored in Redis.  Safe to call multiple times — the second call
 * is a no-op if already running.
 *
 * @returns {Promise<void>}
 */
export async function startNotifications() {
  if (unsubscribeHandle) {
    console.log('[Telegram] Notification listener already running — skipping start.');
    return;
  }

  unsubscribeHandle = await subscribeAll(async (event) => {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error('[Telegram] Error handling event:', err.message);
    }
  });

  console.log('[Telegram] Notification listener started.');
}

/**
 * Stop the Telegram notification listener.
 */
export function stopNotifications() {
  if (unsubscribeHandle) {
    unsubscribeHandle();
    unsubscribeHandle = null;
    console.log('[Telegram] Notification listener stopped.');
  }
}

/**
 * Retrieve current notification settings from Redis.
 * Falls back to DEFAULT_SETTINGS if no settings are stored yet.
 *
 * @returns {Promise<NotificationSettings>}
 */
export async function getNotificationSettings() {
  try {
    const raw = await getRedis().get(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const stored = JSON.parse(raw);
    // Deep-merge so a partial stored object still inherits defaults.
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      events: { ...DEFAULT_SETTINGS.events, ...(stored.events || {}) },
    };
  } catch (err) {
    console.error('[Telegram] Failed to load settings:', err.message);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist updated notification settings to Redis.
 * The provided object is deep-merged with the current settings so callers can
 * send partial updates (e.g. only toggle one event type).
 *
 * @param {Partial<NotificationSettings>} updates
 * @returns {Promise<NotificationSettings>} The resulting merged settings object
 */
export async function updateNotificationSettings(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('Settings must be a plain object');
  }

  const current = await getNotificationSettings();
  const merged = {
    ...current,
    ...updates,
    // Events sub-object is merged one level deep, not replaced wholesale.
    events: { ...current.events, ...(updates.events || {}) },
  };

  await getRedis().set(SETTINGS_KEY, JSON.stringify(merged));
  console.log('[Telegram] Notification settings updated.');
  return merged;
}

// ─── Internal event handler ───────────────────────────────────────────────────

/**
 * Evaluate an incoming event against the current settings and send a Telegram
 * message when appropriate.
 *
 * @param {object} event
 * @returns {Promise<void>}
 */
async function handleEvent(event) {
  const settings = await getNotificationSettings();

  // Master switch
  if (!settings.enabled) return;

  // Check per-event toggle
  const eventEnabled = settings.events?.[event.type];
  if (!eventEnabled) return;

  // Special-case: alex.health_check only triggers when overall === 'CRITICO'
  if (event.type === 'alex.health_check' && event.payload?.overall !== 'CRITICO') return;

  // Determine whether this is a critical event (bypasses quiet hours)
  const isCritical = isCriticalEvent(event);

  // Quiet-hours suppression for non-critical events
  if (!isCritical && isQuietHours(settings)) {
    console.log(`[Telegram] Quiet hours active — suppressing non-critical event: ${event.type}`);
    return;
  }

  const text = formatMessage(event);
  if (!text) return; // Unknown event type — nothing to send

  await sendTelegram(text);
}

// ─── Message formatting ───────────────────────────────────────────────────────

/**
 * Convert an OS event into a Telegram Markdown message string.
 * Returns null for event types that have no registered formatter.
 *
 * @param {object} event
 * @returns {string | null}
 */
function formatMessage(event) {
  const { type, agentId, payload = {} } = event;
  const ts = formatTimestamp(event.ts);

  switch (type) {
    case 'workflow.alert':
      return (
        `🚨 *ALERTA*\n` +
        `${escMd(payload.message || 'Alerta sem descrição')}\n\n` +
        buildMetaLine({ source: payload.source, severity: payload.severity, ts })
      );

    case 'workflow.escalation':
      return (
        `⚠️ *ESCALAÇÃO*\n` +
        `${escMd(payload.message || 'Situação requer atenção imediata')}\n\n` +
        buildMetaLine({ source: payload.source, severity: payload.severity, errors: payload.errors, ts })
      );

    case 'workflow.recovery':
      return (
        `✅ *RECUPERADO*\n` +
        `${escMd(payload.message || `Agente ${agentId || 'desconhecido'} recuperado`)}\n\n` +
        buildMetaLine({ agentId, ts })
      );

    case 'agent.error': {
      const targetAgent = agentId || payload.agentId || 'desconhecido';
      return (
        `❌ *ERRO* — Agent \`${escMd(targetAgent)}\` em estado de erro\n\n` +
        buildMetaLine({ agentId: targetAgent, detail: payload.error || payload.message, ts })
      );
    }

    case 'alex.health_check':
      // Only reached when overall === 'CRITICO' (pre-filtered in handleEvent)
      return (
        `🔴 *INFRAESTRUTURA CRÍTICA*\n` +
        `*${payload.errors ?? 0} erros detectados*\n\n` +
        buildMetaLine({ overall: payload.overall, ts })
      );

    case 'os.boot':
      return (
        `🟢 *AI OS Iniciado* — Sistema online\n\n` +
        buildMetaLine({ version: payload.version, ts })
      );

    default:
      return null;
  }
}

/**
 * Build a small metadata footer line for a Telegram message.
 * Only non-null, non-undefined entries are included.
 *
 * @param {Record<string, string | number | null | undefined>} fields
 * @returns {string}
 */
function buildMetaLine(fields) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `_${escMd(k)}: ${escMd(String(v))}_`);

  return parts.length ? parts.join('  ·  ') : '';
}

/**
 * Format a Unix-ms timestamp into a human-readable string (BRT / Sao Paulo).
 *
 * @param {number | undefined} ts
 * @returns {string}
 */
function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return new Date(ts).toISOString();
  }
}

// ─── Quiet-hours logic ────────────────────────────────────────────────────────

/**
 * Determine whether the current local time (in the settings timezone) falls
 * within the configured quiet window.
 *
 * Handles overnight windows correctly — e.g. 23:00 → 07:00 means
 * "quiet from 23:00 to midnight AND from midnight to 07:00".
 *
 * @param {NotificationSettings} settings
 * @returns {boolean}
 */
function isQuietHours(settings) {
  const { quietHoursStart, quietHoursEnd, timezone } = settings;
  if (!quietHoursStart || !quietHoursEnd) return false;

  try {
    // Get current time components in the target timezone
    const now = new Date();
    const localTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);

    const [nowH, nowM] = localTime.split(':').map(Number);
    const nowMinutes = nowH * 60 + nowM;

    const [startH, startM] = quietHoursStart.split(':').map(Number);
    const startMinutes = startH * 60 + startM;

    const [endH, endM] = quietHoursEnd.split(':').map(Number);
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      // Same-day window: e.g. 10:00 → 14:00
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    } else {
      // Overnight window: e.g. 23:00 → 07:00
      return nowMinutes >= startMinutes || nowMinutes < endMinutes;
    }
  } catch (err) {
    console.error('[Telegram] isQuietHours error:', err.message);
    return false; // Fail open — better to over-notify than to suppress
  }
}

/**
 * Return true if the event should bypass quiet-hours suppression.
 *
 * @param {object} event
 * @returns {boolean}
 */
function isCriticalEvent(event) {
  if (event.type === 'workflow.escalation') return true;
  if (event.type === 'alex.health_check' && event.payload?.overall === 'CRITICO') return true;
  return false;
}

// ─── Markdown escape helper ───────────────────────────────────────────────────

/**
 * Escape Telegram Markdown v1 special characters in a dynamic value so it
 * renders as plain text rather than triggering formatting.
 *
 * Characters escaped: _ * ` [
 *
 * @param {string} str
 * @returns {string}
 */
function escMd(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str.replace(/[_*`[]/g, '\\$&');
}

// ─── JSDoc typedefs ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} NotificationSettings
 * @property {boolean}          enabled
 * @property {string[]}         chatIds
 * @property {string}           quietHoursStart   - "HH:MM" in local timezone
 * @property {string}           quietHoursEnd     - "HH:MM" in local timezone
 * @property {string}           timezone          - IANA timezone string
 * @property {Record<string, boolean>} events     - Per-event-type toggle map
 */
