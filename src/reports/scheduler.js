import cron from 'node-cron';
import { generateDailyReport } from './daily-report.js';
import { generateWeeklyRatingReport } from './weekly-rating-report.js';
import { sendText } from '../quepasa/client.js';
import { config } from '../config.js';
import { generateManagerReport } from '../manager/luan.js';
import { generateTeamMeeting } from '../manager/team-meeting.js';
import { postToOpsInbox } from '../chatwoot/ops-inbox.js';

const REPORT_PHONES = ['5511932145806', '557191234115', '557187700120'];

// WhatsApp group ID for "Fornecedor Rating (Moises/Cred Positivo)"
const RATING_GROUP_ID = process.env.RATING_GROUP_CHAT_ID || '';

// Paulo SDR token — rating report goes out from Paulo's number
const PAULO_TOKEN = config.sdr.botToken;

/**
 * Send the daily report to all configured phone numbers.
 * Returns an object with success/failure details.
 */
export async function sendDailyReportNow() {
  console.log('[ReportScheduler] Triggering daily report...');

  try {
    const report = await generateDailyReport();
    await postToOpsInbox('Relatório Diário — CredPositivo', report, { labels: ['relatorio-diario'] });
    console.log('[ReportScheduler] Relatório diário postado no Chatwoot Operações');

    return {
      success: true,
      report,
      results: [{ channel: 'chatwoot-ops', status: 'sent' }],
      sentCount: 1,
      totalPhones: 1,
    };
  } catch (err) {
    console.error('[ReportScheduler] Failed to generate report:', err.message);
    return {
      success: false,
      error: err.message,
      results: [],
      sentCount: 0,
      totalPhones: REPORT_PHONES.length,
    };
  }
}

/**
 * Send the Luan manager performance report (kept for on-demand API use).
 */
export async function sendManagerReportNow(reportType = 'daily', days = 7) {
  console.log('[ReportScheduler] Triggering Luan manager report...');
  try {
    const { whatsappMessages } = await generateManagerReport({ reportType, days });
    const fullReport = whatsappMessages.join('\n\n---\n\n');
    const title = reportType === 'weekly'
      ? 'Luan — Relatório Semanal (Estratégico)'
      : 'Luan — Relatório Gerencial Diário';
    await postToOpsInbox(title, fullReport, { labels: ['relatorio-luan', `relatorio-${reportType}`] });
    console.log('[ReportScheduler] Luan report postado no Chatwoot Operações');

    return {
      success: true,
      report: fullReport,
      results: [{ channel: 'chatwoot-ops', status: 'sent' }],
      sentCount: 1,
      totalPhones: 1,
    };
  } catch (err) {
    console.error('[ReportScheduler] Luan report error:', err.message);
    return {
      success: false,
      error: err.message,
      results: [],
      sentCount: 0,
      totalPhones: REPORT_PHONES.length,
    };
  }
}

/**
 * Run full team meeting: Luan collects, 5 agents analyze, Igor consolidates.
 * Posts to Ops Inbox in Chatwoot.
 */
export async function sendTeamMeetingNow(reportType = 'weekly', days = 7) {
  console.log('[ReportScheduler] Triggering team meeting...');
  try {
    const { report } = await generateTeamMeeting({ reportType, days });
    const title = 'Reuniao de Time — Analise de Funil';
    await postToOpsInbox(title, report, { labels: ['reuniao-time', 'relatorio-semanal', 'igor'] });
    console.log('[ReportScheduler] Team meeting postado no Chatwoot Operacoes');

    return {
      success: true,
      report,
      results: [{ channel: 'chatwoot-ops', status: 'sent' }],
      sentCount: 1,
      totalPhones: 1,
    };
  } catch (err) {
    console.error('[ReportScheduler] Team meeting error:', err.message);
    return {
      success: false,
      error: err.message,
      results: [],
      sentCount: 0,
      totalPhones: 1,
    };
  }
}

export function startReportScheduler() {
  // 10:00 BRT = 13:00 UTC
  cron.schedule('0 13 * * *', async () => {
    console.log('[ReportScheduler] Cron 10h BRT - sending report');
    await sendDailyReportNow();
  });

  // 18:00 BRT = 21:00 UTC
  cron.schedule('0 21 * * *', async () => {
    console.log('[ReportScheduler] Cron 18h BRT - sending report');
    await sendDailyReportNow();
  });

  // 23:00 BRT = 02:00 UTC (next day)
  cron.schedule('0 2 * * *', async () => {
    console.log('[ReportScheduler] Cron 23h BRT - sending report');
    await sendDailyReportNow();
  });

  console.log('[ReportScheduler] Scheduled daily reports at 10:00, 18:00, 23:00 BRT');

  // Weekly rating report — Monday 10:00 BRT = Monday 13:00 UTC
  cron.schedule('0 13 * * 1', async () => {
    console.log('[ReportScheduler] Cron Monday 10h BRT - sending weekly rating report');
    await sendWeeklyRatingReportNow();
  });

  console.log('[ReportScheduler] Scheduled weekly rating report: Monday 10:00 BRT');

  // === TEAM MEETING: Monday 07:00 BRT = 10:00 UTC ===
  cron.schedule('0 10 * * 1', async () => {
    console.log('[ReportScheduler] Cron Monday 07h BRT - team meeting');
    await sendTeamMeetingNow('weekly', 7);
  });

  console.log('[ReportScheduler] Scheduled team meeting: Monday 07:00 BRT');

  // OLD Luan solo reports — DISABLED (replaced by team meeting)
  // cron.schedule('0 12 * * 1-6', ...) — daily 09:00 BRT
  // cron.schedule('0 11 * * 1', ...) — weekly Monday 08:00 BRT

}

/**
 * Send the weekly rating report to the supplier group + admin phones.
 */
export async function sendWeeklyRatingReportNow() {
  console.log('[ReportScheduler] Triggering weekly rating report...');

  try {
    const report = await generateWeeklyRatingReport();
    await postToOpsInbox('Relatório Semanal — Rating Bancário', report, { labels: ['relatorio-rating', 'semanal'] });
    console.log('[ReportScheduler] Weekly rating report postado no Chatwoot Operações');

    return { success: true, report, results: [{ channel: 'chatwoot-ops', status: 'sent' }], sentCount: 1, totalTargets: 1 };
  } catch (err) {
    console.error('[ReportScheduler] Failed to generate weekly rating report:', err.message);
    return { success: false, error: err.message, results: [], sentCount: 0, totalTargets: 0 };
  }
}
