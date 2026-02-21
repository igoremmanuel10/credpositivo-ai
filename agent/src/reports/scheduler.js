import cron from 'node-cron';
import { generateDailyReport } from './daily-report.js';
import { sendText } from '../quepasa/client.js';

const REPORT_PHONES = ['5511932145806', '557191234115', '557187700120'];

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
}
