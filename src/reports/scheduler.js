import cron from 'node-cron';
import { generateDailyReport } from './daily-report.js';
import { generateWeeklyRatingReport } from './weekly-rating-report.js';
import { sendText } from '../quepasa/client.js';
import { config } from '../config.js';
import { generateManagerReport } from '../manager/luan.js';

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
    const results = [];

    for (const phone of REPORT_PHONES) {
      try {
        await sendText(phone, report);
        console.log('[ReportScheduler] Report sent to ' + phone);
        results.push({ phone, status: 'sent' });
      } catch (err) {
        console.error('[ReportScheduler] Failed to send to ' + phone + ':', err.message);
        results.push({ phone, status: 'failed', error: err.message });
      }
    }

    const sentCount = results.filter(r => r.status === 'sent').length;
    console.log('[ReportScheduler] Report delivered to ' + sentCount + '/' + REPORT_PHONES.length + ' phones');

    return {
      success: sentCount > 0,
      report,
      results,
      sentCount,
      totalPhones: REPORT_PHONES.length,
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
 * Start the daily report scheduler.
 * Sends report 3x/day: 10:00, 18:00, 23:00 BRT
 * (13:00, 21:00, 02:00 UTC)
 */

/**
 * Send the Luan manager performance report to admin phones.
 */
export async function sendManagerReportNow(reportType = 'daily', days = 7) {
  console.log('[ReportScheduler] Triggering Luan manager report...');
  try {
    const { whatsappMessages } = await generateManagerReport({ reportType, days });
    const results = [];

    for (const phone of REPORT_PHONES) {
      try {
        for (const msg of whatsappMessages) {
          await sendText(phone, msg);
        }
        console.log('[ReportScheduler] Luan report sent to ' + phone);
        results.push({ phone, status: 'sent' });
      } catch (err) {
        console.error('[ReportScheduler] Luan report failed for ' + phone + ':', err.message);
        results.push({ phone, status: 'failed', error: err.message });
      }
    }

    const sentCount = results.filter(r => r.status === 'sent').length;
    console.log('[ReportScheduler] Luan report delivered to ' + sentCount + '/' + REPORT_PHONES.length + ' phones');

    return {
      success: sentCount > 0,
      report: whatsappMessages.join('\n---\n'),
      results,
      sentCount,
      totalPhones: REPORT_PHONES.length,
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

  // Luan manager report: 09:00 BRT = 12:00 UTC (Mon-Sat)
  cron.schedule('0 12 * * 1-6', async () => {
    console.log('[ReportScheduler] Cron Luan 09h BRT - manager report');
    await sendManagerReportNow('daily', 1);
  });

  // Luan weekly strategic report: Monday 08:00 BRT = 11:00 UTC
  cron.schedule('0 11 * * 1', async () => {
    console.log('[ReportScheduler] Cron Luan Monday 08h BRT - weekly manager report');
    await sendManagerReportNow('weekly', 7);
  });

  console.log('[ReportScheduler] Scheduled Luan manager reports: daily 09:00 BRT + weekly Monday 08:00 BRT');

}

/**
 * Send the weekly rating report to the supplier group + admin phones.
 */
export async function sendWeeklyRatingReportNow() {
  console.log('[ReportScheduler] Triggering weekly rating report...');

  try {
    const report = await generateWeeklyRatingReport();
    const targets = [];

    // Send to group if configured
    if (RATING_GROUP_ID) {
      targets.push(RATING_GROUP_ID);
    }

    // Also send to admin phones
    for (const phone of REPORT_PHONES) {
      targets.push(phone);
    }

    const results = [];
    for (const target of targets) {
      try {
        await sendText(target, report, PAULO_TOKEN);
        console.log('[ReportScheduler] Weekly rating report sent to ' + target);
        results.push({ target, status: 'sent' });
      } catch (err) {
        console.error('[ReportScheduler] Weekly rating failed for ' + target + ':', err.message);
        results.push({ target, status: 'failed', error: err.message });
      }
    }

    const sentCount = results.filter(r => r.status === 'sent').length;
    console.log('[ReportScheduler] Weekly rating delivered to ' + sentCount + '/' + targets.length);

    return { success: sentCount > 0, report, results, sentCount, totalTargets: targets.length };
  } catch (err) {
    console.error('[ReportScheduler] Failed to generate weekly rating report:', err.message);
    return { success: false, error: err.message, results: [], sentCount: 0, totalTargets: 0 };
  }
}
