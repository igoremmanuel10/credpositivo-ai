import express from 'express';
import { readFileSync } from 'fs';
import { config } from './config.js';
import { webhookRouter } from './evolution/webhook.js';
import { paymentRouter } from './payment/routes.js';
import { usersRouter } from './api/users.js';
import { documentsRouter } from './api/documents.js';
import { ratingFormRouter } from './api/rating-form.js';
import { webhooksRouter } from './api/webhooks.js';
import { couponRouter } from './payment/coupons.js';
import { startFollowupScheduler } from './conversation/followup.js';
import { initTokenMapping } from './quepasa/client.js';
import { requireAdmin } from './api/auth.js';
import { voicecallRouter } from './voicecall/routes.js';
import { initWavoip } from './voicecall/wavoip.js';
import { vapiWebhookRouter } from "./voice/vapi-webhook.js";
import { startVapiScheduler } from "./voice/scheduler.js";
import { getBridgeHealth } from './bridge-health.js';
import { startBridgeWatchdog } from './bridge-watchdog.js';
import { startReportScheduler, sendDailyReportNow } from './reports/scheduler.js';
import { getCostSummary } from './monitoring/cost-tracker.js';

const app = express();

app.use(express.json({ limit: '50mb' }));

// CORS for frontend
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    agent: 'CredPositivo Agents v2 (Augusto + Paulo SDR)',
    services: {
      quepasa: config.quepasa.apiUrl,
      chatwoot: config.chatwoot.apiUrl,
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

// Voice call routes (Wavoip)
app.use(voicecallRouter);
// Vapi.ai voice call webhooks
app.use(vapiWebhookRouter);

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

// Start server with async initialization
(async () => {
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
    initWavoip();
    startVapiScheduler();
    startBridgeWatchdog();
    startReportScheduler();
  });
})();
