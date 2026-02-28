/**
 * Error Interceptor — captures console.error into a ring buffer for Alex DevOps agent.
 * Monkey-patches console.error AFTER Sentry init so both Sentry and stdout remain intact.
 */

const MAX_BUFFER_SIZE = 500;
const DEDUP_WINDOW_MS = 60_000; // 60 seconds

const errorBuffer = [];
let lastErrorHash = '';
let lastErrorTime = 0;

const CATEGORY_PREFIXES = {
  '[Quepasa]': 'quepasa',
  '[Chatwoot]': 'chatwoot',
  '[Redis]': 'redis',
  '[DB]': 'database',
  '[Express]': 'application',
  '[Bridge]': 'bridge',
  '[Sentry]': 'sentry',
  '[Manager]': 'application',
  '[Followup]': 'application',
  '[Payment]': 'payment',
  '[VAPI]': 'vapi',
  '[Wavoip]': 'voicecall',
  '[EmbedJob]': 'embeddings',
  '[Ana]': 'ops',
  '[Luan]': 'manager',
  '[Coaching]': 'coaching',
};

function categorize(msg) {
  for (const [prefix, cat] of Object.entries(CATEGORY_PREFIXES)) {
    if (msg.includes(prefix)) return cat;
  }
  return 'application';
}

function hashError(msg) {
  // Simple hash: first 120 chars normalized
  return msg.substring(0, 120).replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim();
}

/**
 * Initialize the error interceptor.
 * Call ONCE, right after Sentry init, before any other module loads.
 */
export function initErrorInterceptor() {
  const originalError = console.error.bind(console);

  console.error = (...args) => {
    // Always call original FIRST (Sentry + stdout)
    originalError(...args);

    // Build message string
    const msg = args.map(a => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
      if (typeof a === 'object') {
        try { return JSON.stringify(a).substring(0, 500); } catch { return String(a); }
      }
      return String(a);
    }).join(' ');

    // Skip Alex's own messages to avoid feedback loop
    if (msg.includes('[Alex]')) return;

    // Deduplicate within window
    const hash = hashError(msg);
    const now = Date.now();
    if (hash === lastErrorHash && (now - lastErrorTime) < DEDUP_WINDOW_MS) {
      // Update count on existing entry
      const last = errorBuffer[errorBuffer.length - 1];
      if (last && last.hash === hash) {
        last.count++;
        last.lastSeen = new Date().toISOString();
      }
      return;
    }
    lastErrorHash = hash;
    lastErrorTime = now;

    // Add to buffer
    errorBuffer.push({
      timestamp: new Date().toISOString(),
      message: msg.substring(0, 2000),
      category: categorize(msg),
      hash,
      count: 1,
      lastSeen: new Date().toISOString(),
    });

    // Ring buffer: remove oldest if over max
    if (errorBuffer.length > MAX_BUFFER_SIZE) {
      errorBuffer.shift();
    }
  };

  console.log('[Alex] Error interceptor initialized (buffer max: ' + MAX_BUFFER_SIZE + ')');
}

/**
 * Get errors from the last N minutes.
 */
export function getRecentErrors(minutes = 10) {
  const cutoff = Date.now() - (minutes * 60 * 1000);
  return errorBuffer.filter(e => new Date(e.timestamp).getTime() >= cutoff);
}

/**
 * Get error patterns (grouped by category) from the last 24 hours.
 */
export function getErrorPatterns() {
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  const recent = errorBuffer.filter(e => new Date(e.timestamp).getTime() >= cutoff);

  const patterns = {};
  for (const err of recent) {
    if (!patterns[err.category]) {
      patterns[err.category] = { count: 0, samples: [] };
    }
    patterns[err.category].count += err.count;
    if (patterns[err.category].samples.length < 3) {
      patterns[err.category].samples.push(err.message.substring(0, 200));
    }
  }
  return patterns;
}

/**
 * Clear all errors from the buffer.
 */
export function clearErrorBuffer() {
  errorBuffer.length = 0;
  lastErrorHash = '';
  lastErrorTime = 0;
}

/**
 * Get buffer stats.
 */
export function getBufferStats() {
  return {
    total: errorBuffer.length,
    maxSize: MAX_BUFFER_SIZE,
    oldest: errorBuffer[0]?.timestamp || null,
    newest: errorBuffer[errorBuffer.length - 1]?.timestamp || null,
  };
}
