import { initSentry, Sentry } from './monitoring/sentry.js';
initSentry();

import { initErrorInterceptor } from './devops/error-interceptor.js';
initErrorInterceptor();

import express from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './config.js';
import { webhookRouter } from './evolution/webhook.js';
import { paymentRouter } from './payment/routes.js';
import { usersRouter } from './api/users.js';
import { documentsRouter } from './api/documents.js';
import { ratingFormRouter } from './api/rating-form.js';
import { webhooksRouter } from './api/webhooks.js';
import { couponRouter } from './payment/coupons.js';
import { startFollowupScheduler } from './conversation/followup.js';
import { startReengagementScheduler } from './conversation/reengagement.js';
import { initTokenMapping } from './quepasa/client.js';
import { requireAdmin } from './api/auth.js';
import { voicecallRouter } from './voicecall/routes.js';
import { initWavoip } from './voicecall/wavoip.js';
import { vapiWebhookRouter } from "./voice/vapi-webhook.js";
import { startVapiScheduler } from "./voice/scheduler.js";
import { getBridgeHealth } from './bridge-health.js';
import { startBridgeWatchdog } from './bridge-watchdog.js';
import { startReportScheduler, sendDailyReportNow, sendWeeklyRatingReportNow, sendManagerReportNow } from './reports/scheduler.js';
import { generateManagerReport } from './manager/luan.js';
import { getCostSummary } from './monitoring/cost-tracker.js';
import { analyticsRouter } from './api/analytics.js';
import { abTestsRouter } from './api/ab-tests.js';
import { performanceRouter } from './api/analytics-performance.js';
import { startExpenseScheduler } from './expense/tracker.js';
import { startCoachingScheduler } from './coaching/protocol.js';
import { startAgendaScheduler } from './agenda/manager.js';
import { startEventDetector } from './conversation/event-detector.js';
import { runMigrations, db } from './db/client.js';
import { processUnembeddedConversations, refreshStaleEmbeddings } from './ai/embed-job.js';
import { affiliateRouter } from './affiliate/routes.js';
import { startAnaScheduler } from './ops/ana.js';
import { startAlexScheduler, sendAlexReportNow, runAlexCheckCycle } from './devops/alex.js';
import { startAdsScheduler, getAdsSnapshot, sendAdsReport } from './ads/manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

app.use(express.json({ limit: '50mb' }));

// CORS — whitelist allowed origins
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// JWT auth for all /api/admin/* routes except login and 2FA
app.use('/api/admin', (req, res, next) => {
  // Allow login and 2FA endpoints without full token (they verify their own temp tokens)
  if (req.path === '/login' && req.method === 'POST') return next();
  if (req.path === '/2fa/setup' && req.method === 'POST') return next();
  if (req.path === '/2fa/verify' && req.method === 'POST') return next();
  requireAdmin(req, res, next);
});

// Health check
app.get('/health', async (req, res) => {
  let dbOk = false;
  try {
    await db.query('SELECT 1');
    dbOk = true;
  } catch {}

  res.json({
    status: dbOk ? 'ok' : 'degraded',
    agent: 'CredPositivo Agents v2 (Augusto + Paulo SDR)',
    uptime: Math.round(process.uptime()),
    services: {
      quepasa: config.quepasa.apiUrl,
      chatwoot: config.chatwoot.apiUrl,
      postgres: dbOk ? 'ok' : 'unreachable',
    },
    timestamp: new Date().toISOString(),
  });
});

// Monitor status (Fernando Dev)
app.get('/monitor', (req, res) => {
  try {
    const data = readFileSync('/data/monitor/status.json', 'utf-8');
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch {
    res.status(503).json({ status: 'no_data', message: 'Monitor not yet initialized' });
  }
});

// Bridge health check
app.get('/bridge-health', (req, res) => {
  res.json(getBridgeHealth());
});

// Users/Admin API routes
app.use(usersRouter);
app.use(documentsRouter);
app.use(ratingFormRouter);

// SDR webhook events (register, purchase, etc.)
app.use(webhooksRouter);

// Webhook routes (Quepasa + Chatwoot)
app.use(webhookRouter);

// Payment routes (Mercado Pago + Apiful)
app.use(paymentRouter);

// Coupon management
app.use(couponRouter);

// Affiliate program routes
app.use(affiliateRouter);

// Voice call routes (Wavoip)
app.use(voicecallRouter);
// Vapi.ai voice call webhooks
app.use(vapiWebhookRouter);

// Analytics API (admin only)
app.use(analyticsRouter);

// A/B Testing API (admin only)
app.use(abTestsRouter);
app.use(performanceRouter);

// Admin Dashboard (self-contained HTML)
app.get('/admin/dashboard', (req, res) => {
  res.sendFile(join(__dirname, 'admin', 'dashboard.html'));
});
app.get('/admin/analytics', (req, res) => {
  res.sendFile(join(__dirname, 'admin', 'analytics.html'));
});
app.get('/admin/performance', (req, res) => {
  res.sendFile(join(__dirname, 'admin', 'performance.html'));
});

// API cost summary (admin only)
app.get('/api/admin/costs', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7');
    const summary = await getCostSummary(days);
    res.json({ days, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Daily report manual trigger
app.post('/api/admin/daily-report', async (req, res) => {
  try {
    const result = await sendDailyReportNow();
    res.json({
      success: result.success,
      message: 'Relatorio enviado para ' + result.sentCount + '/' + result.totalPhones + ' telefones',
      results: result.results,
    });
  } catch (err) {
    console.error('[Admin] Daily report error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Weekly rating report manual trigger
app.post('/api/admin/weekly-rating-report', async (req, res) => {
  try {
    const result = await sendWeeklyRatingReportNow();
    res.json({
      success: result.success,
      message: 'Relatorio rating enviado para ' + result.sentCount + '/' + result.totalTargets + ' destinos',
      results: result.results,
    });
  } catch (err) {
    console.error('[Admin] Weekly rating report error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// Luan manager report - manual trigger (sends via WhatsApp)
app.post('/api/admin/manager-report', async (req, res) => {
  try {
    const days = parseInt(req.body.days || '7');
    const reportType = req.body.report_type || 'on_demand';
    const result = await sendManagerReportNow(reportType, days);
    res.json({
      success: result.success,
      message: 'Relatorio Luan enviado para ' + result.sentCount + '/' + result.totalPhones + ' telefones',
      results: result.results,
    });
  } catch (err) {
    console.error('[Admin] Manager report error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Luan manager report - JSON only (for dashboard)
app.get('/api/admin/manager-report', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7');
    const { jsonData } = await generateManagerReport({ reportType: 'on_demand', days });
    res.json(jsonData);
  } catch (err) {
    console.error('[Admin] Manager report JSON error:', err);
    res.status(500).json({ error: err.message });
  }
});


// Alex DevOps report - manual trigger (sends via WhatsApp)
app.post('/api/admin/devops-report', async (req, res) => {
  try {
    const result = await sendAlexReportNow();
    res.json({
      success: result.success,
      message: 'Relatorio Alex enviado para ' + result.sentCount + '/' + result.totalPhones + ' telefones',
      results: result.results,
    });
  } catch (err) {
    console.error('[Admin] DevOps report error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Alex DevOps health - JSON (for dashboard/monitoring)
app.get('/api/admin/devops-health', async (req, res) => {
  try {
    const result = await runAlexCheckCycle();
    res.json(result);
  } catch (err) {
    console.error('[Admin] DevOps health error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Express] Unhandled error:', err);
  if (Sentry) Sentry.captureException(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server with async initialization
(async () => {
  // Run database migrations (idempotent)
  await runMigrations();

  // Initialize token mapping for multi-number support
  await initTokenMapping();

  app.listen(config.port, () => {
    console.log(`
=============================================
  CredPositivo Agents v2 (Augusto + Paulo SDR)
  Port: ${config.port}
  Chat: ${config.anthropic.model}
  Vision/TTS: ${config.openai.visionModel} + ${config.tts.model}
  Quepasa: ${config.quepasa.apiUrl}
  Chatwoot: ${config.chatwoot.apiUrl}
  Payments: ${config.mercadopago.accessToken ? 'Mercado Pago ON' : 'Mercado Pago OFF'}
  Apiful: ${config.apiful.token ? 'ON' : 'OFF'}
  Bot Tokens: ${config.quepasa.botTokens.length} configured
  SDR Paulo: ${config.sdr.enabled ? 'ON' : 'OFF'} (${config.sdr.botPhone})
  Wavoip: ${config.wavoip.enabled ? 'ON' : 'OFF'}
=============================================
    `);

    startFollowupScheduler();
    startReengagementScheduler();
    initWavoip();
    startVapiScheduler();
    startBridgeWatchdog();
    startReportScheduler();
    startExpenseScheduler();
    startCoachingScheduler();
    startAgendaScheduler();
    startEventDetector();
    startAnaScheduler();
    startAlexScheduler();
    startAdsScheduler();

    // Embedding job: process new conversations every 30 minutes, refresh stale daily
    setInterval(() => {
      processUnembeddedConversations().catch(err =>
        console.error('[EmbedJob] Scheduler error:', err.message)
      );
    }, 30 * 60 * 1000);
    setInterval(() => {
      refreshStaleEmbeddings().catch(err =>
        console.error('[EmbedJob] Refresh error:', err.message)
      );
    }, 24 * 60 * 60 * 1000);
    // Run initial embedding pass after 2 min startup delay
    setTimeout(() => {
      processUnembeddedConversations().catch(() => {});
    }, 2 * 60 * 1000);
  });
})();
