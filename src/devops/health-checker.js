/**
 * Health Checker — probes all services and returns structured health data.
 */

import { db } from '../db/client.js';
import { config } from '../config.js';
import { getBridgeHealth } from '../bridge-health.js';
import { cache } from '../db/redis.js';

/**
 * Check PostgreSQL connectivity and pool stats.
 */
async function checkPostgres() {
  const start = Date.now();
  try {
    const result = await db.query('SELECT 1 AS ok');
    const pool = db.pool;
    return {
      service: 'postgres',
      status: 'ok',
      responseTimeMs: Date.now() - start,
      details: {
        totalCount: pool?.totalCount || 0,
        idleCount: pool?.idleCount || 0,
        waitingCount: pool?.waitingCount || 0,
      },
    };
  } catch (err) {
    return {
      service: 'postgres',
      status: 'down',
      responseTimeMs: Date.now() - start,
      error: err.message,
    };
  }
}

/**
 * Check Redis connectivity.
 */
async function checkRedis() {
  const start = Date.now();
  try {
    await cache.getConversation('__health_check__');
    return {
      service: 'redis',
      status: 'ok',
      responseTimeMs: Date.now() - start,
    };
  } catch (err) {
    return {
      service: 'redis',
      status: 'down',
      responseTimeMs: Date.now() - start,
      error: err.message,
    };
  }
}

/**
 * Check Quepasa (WhatsApp gateway) connectivity.
 */
async function checkQuepasa() {
  const start = Date.now();
  try {
    const token = config.quepasa.botTokens[0] || config.quepasa.botToken;
    if (!token) {
      return { service: 'quepasa', status: 'degraded', responseTimeMs: 0, error: 'No bot token configured' };
    }
    const url = `${config.quepasa.apiUrl}/v3/bot/${token}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (resp.ok) {
      return { service: 'quepasa', status: 'ok', responseTimeMs: Date.now() - start };
    }
    return { service: 'quepasa', status: 'degraded', responseTimeMs: Date.now() - start, error: `HTTP ${resp.status}` };
  } catch (err) {
    return { service: 'quepasa', status: 'down', responseTimeMs: Date.now() - start, error: err.message };
  }
}

/**
 * Check Chatwoot connectivity.
 */
async function checkChatwoot() {
  const start = Date.now();
  try {
    // Use authenticated profile endpoint — reliable check
    const resp = await fetch(`${config.chatwoot.apiUrl}/api/v1/profile`, {
      headers: { api_access_token: config.chatwoot.apiToken },
      signal: AbortSignal.timeout(10000),
    });
    return {
      service: 'chatwoot',
      status: resp.ok ? 'ok' : resp.status < 500 ? 'ok' : 'degraded',
      responseTimeMs: Date.now() - start,
    };
  } catch (err) {
    return { service: 'chatwoot', status: 'down', responseTimeMs: Date.now() - start, error: err.message };
  }
}

/**
 * Check Bridge health (in-memory state).
 */
function checkBridge() {
  try {
    const health = getBridgeHealth();
    const now = Date.now();

    // Determine bridge status based on activity AND errors
    let status = 'ok';
    const errorCount = health.errorCount || 0;

    if (errorCount > 10) {
      // High error count always means degraded
      status = 'degraded';
    } else if (health.lastQuepasaToChatwoot) {
      const lastActivity = new Date(health.lastQuepasaToChatwoot).getTime();
      const inactiveMins = (now - lastActivity) / (60 * 1000);
      if (inactiveMins > 30 && errorCount > 0) {
        // No recent activity AND there are errors — genuinely degraded
        status = 'degraded';
      } else if (inactiveMins > 30) {
        // No recent activity but zero errors — normal idle (e.g., nighttime)
        status = 'idle';
      }
    }

    return {
      service: 'bridge',
      status,
      details: {
        lastQuepasaToChatwoot: health.lastQuepasaToChatwoot,
        lastChatwootToQuepasa: health.lastChatwootToQuepasa,
        errorCount: health.errorCount,
        lastError: health.lastError?.message || null,
      },
    };
  } catch (err) {
    return { service: 'bridge', status: 'degraded', error: err.message };
  }
}

/**
 * Check API cost usage (today + week).
 */
async function checkAPICosts() {
  try {
    const todayResult = await db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_costs WHERE created_at >= CURRENT_DATE`
    );
    const weekResult = await db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_costs WHERE created_at >= NOW() - INTERVAL '7 days'`
    );
    return {
      service: 'api_costs',
      status: 'ok',
      details: {
        todayUSD: parseFloat(todayResult.rows[0].total),
        weekUSD: parseFloat(weekResult.rows[0].total),
      },
    };
  } catch (err) {
    return { service: 'api_costs', status: 'degraded', error: err.message };
  }
}

/**
 * Check Node.js process health.
 */
function checkProcessHealth() {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const uptimeHours = Math.round(process.uptime() / 3600 * 10) / 10;

  // Flag degraded if heap > 512MB or RSS > 1GB
  let status = 'ok';
  if (rssMB > 1024) status = 'degraded';
  else if (heapUsedMB > 512) status = 'degraded';

  return {
    service: 'process',
    status,
    details: {
      heapUsedMB,
      heapTotalMB,
      rssMB,
      uptimeHours,
      pid: process.pid,
    },
  };
}

/**
 * Run all health checks in parallel.
 * Returns overall status + individual results.
 */
export async function checkAllServices() {
  const results = await Promise.allSettled([
    checkPostgres(),
    checkRedis(),
    checkQuepasa(),
    checkChatwoot(),
    Promise.resolve(checkBridge()),
    checkAPICosts(),
    Promise.resolve(checkProcessHealth()),
  ]);

  const services = results.map(r =>
    r.status === 'fulfilled' ? r.value : { service: 'unknown', status: 'down', error: r.reason?.message }
  );

  // Determine overall status
  const coreServices = ['postgres', 'quepasa'];
  const coreDown = services.some(s => coreServices.includes(s.service) && s.status === 'down');
  const anyDegraded = services.some(s => s.status === 'degraded');
  const anyDown = services.some(s => s.status === 'down');

  let overall = 'OK';
  if (coreDown) overall = 'CRITICO';
  else if (anyDown || anyDegraded) overall = 'DEGRADADO';

  return { overall, services, timestamp: new Date().toISOString() };
}
