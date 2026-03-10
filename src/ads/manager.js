/**
 * Ads Manager — Meta Ads Monitor & Optimizer
 *
 * Monitora campanhas Meta Ads e envia relatórios/alertas no grupo ADM.
 * Level 2: Monitor + recomendações automáticas + ajuste com aprovação.
 *
 * Schedule (BRT / UTC):
 *   08:00 / 11:00  — Check matinal (performance ontem + budget check)
 *   12:00 / 15:00  — Midday pulse (CPA/CPL alertas se fora do target)
 *   18:00 / 21:00  — Daily report completo + recomendações
 *   every 2h biz   — Anomaly detection (spend spike, CPA spike, delivery issues)
 *
 * Zero AI calls — pure API + formatting.
 */

import cron from 'node-cron';
import { config } from '../config.js';
import { postToOpsInbox } from '../chatwoot/ops-inbox.js';
import { sendText, getTokenForWid } from '../quepasa/client.js';
import { db } from '../db/client.js';
import { emit, setStatus, reportMetrics } from '../os/emitter.js';

// --- Config ---
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || 'act_878035622660192';
const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const API_VERSION = 'v21.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

const ADM_GROUP_JID = config.admGroupJid || process.env.ADM_GROUP_JID;
const AUGUSTO_WID = '5571936180654';

// Thresholds
const THRESHOLDS = {
  cplMax: 15.0,        // R$ max por lead
  cpaMax: 50.0,        // R$ max por aquisição
  ctrMin: 0.8,         // % mínimo CTR
  spendSpikePercent: 50, // % acima da média = alerta
  frequencyMax: 3.0,   // frequência máxima antes de fadiga
};

let lastKnownMetrics = null;
let tokenRefreshTimer = null;

// --- Meta API Helper ---
async function metaGet(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set('access_token', META_ACCESS_TOKEN);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`[AdsManager] Meta API error: ${res.status}`, err);
    return null;
  }
  return res.json();
}

// --- Data Fetchers ---
async function getCampaigns() {
  return metaGet(`${META_AD_ACCOUNT_ID}/campaigns`, {
    fields: 'id,name,status,objective,daily_budget,lifetime_budget,budget_remaining',
    filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }]),
    limit: '50',
  });
}

async function getCampaignInsights(datePreset = 'yesterday') {
  return metaGet(`${META_AD_ACCOUNT_ID}/insights`, {
    fields: 'campaign_name,campaign_id,spend,impressions,clicks,cpc,cpm,ctr,reach,frequency,actions,cost_per_action_type,conversions',
    date_preset: datePreset,
    level: 'campaign',
    limit: '50',
  });
}

async function getAdSetInsights(datePreset = 'yesterday') {
  return metaGet(`${META_AD_ACCOUNT_ID}/insights`, {
    fields: 'adset_name,adset_id,spend,impressions,clicks,ctr,cpc,reach,frequency,actions,cost_per_action_type',
    date_preset: datePreset,
    level: 'adset',
    limit: '50',
  });
}

async function getAccountSpend(datePreset = 'this_month') {
  return metaGet(`${META_AD_ACCOUNT_ID}/insights`, {
    fields: 'spend,impressions,clicks,reach,actions',
    date_preset: datePreset,
  });
}

async function getTodaySpend() {
  return metaGet(`${META_AD_ACCOUNT_ID}/insights`, {
    fields: 'spend,impressions,clicks,reach,actions,ctr,cpc',
    date_preset: 'today',
  });
}

// --- Extract Metrics ---
function extractLeads(actions) {
  if (!actions) return 0;
  const leadAction = actions.find(a =>
    a.action_type === 'lead' ||
    a.action_type === 'offsite_conversion.fb_pixel_lead' ||
    a.action_type === 'onsite_conversion.messaging_first_reply'
  );
  return leadAction ? parseInt(leadAction.value) : 0;
}

function extractCPL(costPerAction) {
  if (!costPerAction) return null;
  const cpl = costPerAction.find(a =>
    a.action_type === 'lead' ||
    a.action_type === 'offsite_conversion.fb_pixel_lead' ||
    a.action_type === 'onsite_conversion.messaging_first_reply'
  );
  return cpl ? parseFloat(cpl.value) : null;
}

function extractMessages(actions) {
  if (!actions) return 0;
  const msg = actions.find(a =>
    a.action_type === 'onsite_conversion.messaging_conversation_started_7d' ||
    a.action_type === 'onsite_conversion.messaging_first_reply'
  );
  return msg ? parseInt(msg.value) : 0;
}

// --- Formatters ---
function formatCurrency(val) {
  if (val == null) return '-';
  return `R$ ${parseFloat(val).toFixed(2)}`;
}

function formatPercent(val) {
  if (val == null) return '-';
  return `${parseFloat(val).toFixed(2)}%`;
}

function formatNumber(val) {
  if (val == null) return '0';
  return parseInt(val).toLocaleString('pt-BR');
}

// --- Notification ---
async function notify(text) {
  try {
    const token = getTokenForWid(AUGUSTO_WID);
    await postToOpsInbox('AdsManager — Relatório Meta Ads', text, { labels: ['relatorio-ads', 'meta-ads'] });
  } catch (err) {
    console.error(`[AdsManager] Notify error:`, err.message);
  }
}

// --- Save metrics to DB for history ---
async function saveMetricsSnapshot(type, data) {
  try {
    await db.query(`
      INSERT INTO ads_metrics (type, data, created_at)
      VALUES ($1, $2, NOW())
    `, [type, JSON.stringify(data)]);
  } catch (err) {
    // Table may not exist yet, create it
    if (err.message.includes('does not exist')) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ads_metrics (
          id SERIAL PRIMARY KEY,
          type VARCHAR(50) NOT NULL,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await db.query(`
        INSERT INTO ads_metrics (type, data, created_at)
        VALUES ($1, $2, NOW())
      `, [type, JSON.stringify(data)]);
    }
  }
}

// --- Morning Check (08:00 BRT) ---
async function morningCheck() {
  console.log('[AdsManager] Running morning check...');

  try {
    const [campaigns, yesterday] = await Promise.all([
      getCampaigns(),
      getCampaignInsights('yesterday'),
    ]);

    if (!campaigns?.data?.length) {
      console.log('[AdsManager] No campaigns found');
      return;
    }

    const activeCampaigns = campaigns.data.filter(c => c.status === 'ACTIVE');
    const insights = yesterday?.data || [];

    let totalSpend = 0;
    let totalClicks = 0;
    let totalImpressions = 0;
    let totalLeads = 0;
    let totalMessages = 0;

    const lines = ['*[ADS] Check Matinal*\n'];

    for (const ins of insights) {
      const spend = parseFloat(ins.spend || 0);
      const clicks = parseInt(ins.clicks || 0);
      const impressions = parseInt(ins.impressions || 0);
      const ctr = parseFloat(ins.ctr || 0);
      const leads = extractLeads(ins.actions);
      const msgs = extractMessages(ins.actions);
      const cpl = extractCPL(ins.cost_per_action_type);

      totalSpend += spend;
      totalClicks += clicks;
      totalImpressions += impressions;
      totalLeads += leads;
      totalMessages += msgs;

      lines.push(`*${ins.campaign_name}*`);
      lines.push(`Gasto: ${formatCurrency(spend)} | Cliques: ${formatNumber(clicks)} | CTR: ${formatPercent(ctr)}`);
      if (leads > 0) lines.push(`Leads: ${leads} | CPL: ${formatCurrency(cpl)}`);
      if (msgs > 0) lines.push(`Mensagens: ${msgs}`);
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Total ontem:* ${formatCurrency(totalSpend)} | ${formatNumber(totalClicks)} cliques | ${totalLeads} leads`);

    if (totalLeads > 0) {
      const avgCPL = totalSpend / totalLeads;
      lines.push(`*CPL médio:* ${formatCurrency(avgCPL)}`);
      if (avgCPL > THRESHOLDS.cplMax) {
        lines.push(`\n⚠ CPL acima do target (${formatCurrency(THRESHOLDS.cplMax)}). Recomendo revisar segmentação.`);
      }
    }

    lines.push(`\n*Campanhas ativas:* ${activeCampaigns.length}`);

    const text = lines.join('\n');
    await notify(text);
    await saveMetricsSnapshot('morning_check', { totalSpend, totalClicks, totalImpressions, totalLeads, totalMessages });

    lastKnownMetrics = { totalSpend, totalClicks, totalImpressions, totalLeads, date: new Date().toISOString() };

    const cpl = totalLeads > 0 ? totalSpend / totalLeads : null;
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null;
    await emit('carol.ads_check', 'carol', { campaigns: activeCampaigns.length, spend: totalSpend, cpl });
    await reportMetrics('carol', { campaigns: activeCampaigns.length, spend_today: totalSpend, cpl, ctr });
    await setStatus('carol', 'online');
    console.log('[AdsManager] Morning check done');
  } catch (err) {
    console.error('[AdsManager] Morning check error:', err.message);
  }
}

// --- Midday Pulse (12:00 BRT) ---
async function middayPulse() {
  console.log('[AdsManager] Running midday pulse...');

  try {
    const today = await getTodaySpend();
    if (!today?.data?.length) return;

    const ins = today.data[0];
    const spend = parseFloat(ins.spend || 0);
    const clicks = parseInt(ins.clicks || 0);
    const ctr = parseFloat(ins.ctr || 0);
    const leads = extractLeads(ins.actions);

    // Only alert if something noteworthy
    const issues = [];
    if (spend > 0 && leads === 0 && clicks > 20) {
      issues.push('Nenhum lead ainda com ' + clicks + ' cliques — verificar landing page');
    }
    if (ctr > 0 && ctr < THRESHOLDS.ctrMin) {
      issues.push(`CTR baixo (${formatPercent(ctr)}) — criativo pode estar cansado`);
    }
    if (leads > 0) {
      const cpl = spend / leads;
      if (cpl > THRESHOLDS.cplMax * 1.5) {
        issues.push(`CPL ${formatCurrency(cpl)} muito acima do target — considerar pausar`);
      }
    }

    if (issues.length > 0) {
      const text = `*[ADS] Alerta Meio-Dia*\n\nHoje até agora: ${formatCurrency(spend)} | ${formatNumber(clicks)} cliques | ${leads} leads\n\n⚠ ${issues.join('\n⚠ ')}`;
      await notify(text);
    } else {
      console.log(`[AdsManager] Midday pulse OK — R$${spend.toFixed(2)}, ${leads} leads, no issues`);
    }
  } catch (err) {
    console.error('[AdsManager] Midday pulse error:', err.message);
  }
}

// --- Daily Report (18:00 BRT) ---
async function dailyReport() {
  console.log('[AdsManager] Running daily report...');

  try {
    const [campaigns, todayIns, yesterdayIns, monthIns] = await Promise.all([
      getCampaigns(),
      getCampaignInsights('today'),
      getCampaignInsights('yesterday'),
      getAccountSpend('this_month'),
    ]);

    const todayData = todayIns?.data || [];
    const yesterdayData = yesterdayIns?.data || [];
    const monthData = monthIns?.data?.[0] || {};

    // Today totals
    let tSpend = 0, tClicks = 0, tLeads = 0, tMsgs = 0, tImpressions = 0;
    for (const ins of todayData) {
      tSpend += parseFloat(ins.spend || 0);
      tClicks += parseInt(ins.clicks || 0);
      tImpressions += parseInt(ins.impressions || 0);
      tLeads += extractLeads(ins.actions);
      tMsgs += extractMessages(ins.actions);
    }

    // Yesterday totals
    let ySpend = 0, yLeads = 0;
    for (const ins of yesterdayData) {
      ySpend += parseFloat(ins.spend || 0);
      yLeads += extractLeads(ins.actions);
    }

    // Month total
    const mSpend = parseFloat(monthData.spend || 0);

    const lines = ['*[ADS] Relatório Diário*\n'];

    // Per campaign breakdown
    for (const ins of todayData) {
      const spend = parseFloat(ins.spend || 0);
      if (spend === 0) continue;
      const leads = extractLeads(ins.actions);
      const ctr = parseFloat(ins.ctr || 0);
      const cpl = leads > 0 ? spend / leads : null;

      lines.push(`*${ins.campaign_name}*`);
      lines.push(`Gasto: ${formatCurrency(spend)} | CTR: ${formatPercent(ctr)} | Leads: ${leads}${cpl ? ` | CPL: ${formatCurrency(cpl)}` : ''}`);

      // Flags
      if (cpl && cpl > THRESHOLDS.cplMax) lines.push(`  ⚠ CPL alto`);
      if (ctr < THRESHOLDS.ctrMin && parseInt(ins.impressions || 0) > 500) lines.push(`  ⚠ CTR baixo`);
      lines.push('');
    }

    // Summary
    lines.push('---');
    lines.push(`*Hoje:* ${formatCurrency(tSpend)} | ${formatNumber(tClicks)} cliques | ${tLeads} leads`);
    if (tLeads > 0) lines.push(`*CPL hoje:* ${formatCurrency(tSpend / tLeads)}`);
    if (ySpend > 0) {
      const diff = ((tSpend - ySpend) / ySpend * 100).toFixed(0);
      lines.push(`*vs ontem:* ${diff > 0 ? '+' : ''}${diff}% gasto | ${yLeads} leads ontem`);
    }
    lines.push(`\n*Mês:* ${formatCurrency(mSpend)} total`);

    // Recommendations
    const recs = [];
    if (tLeads > 0 && tSpend / tLeads < THRESHOLDS.cplMax * 0.7) {
      recs.push('CPL abaixo do target — considere aumentar budget para escalar');
    }
    if (tLeads > 0 && tSpend / tLeads > THRESHOLDS.cplMax) {
      recs.push('CPL acima do target — revisar público/criativo ou reduzir budget');
    }
    if (tImpressions > 1000 && tClicks === 0) {
      recs.push('Zero cliques com impressões — criativo precisa de atenção urgente');
    }

    if (recs.length > 0) {
      lines.push('\n*Recomendações:*');
      recs.forEach(r => lines.push(`→ ${r}`));
    }

    // Active campaigns count
    const active = campaigns?.data?.filter(c => c.status === 'ACTIVE')?.length || 0;
    lines.push(`\n*Campanhas ativas:* ${active}`);

    const text = lines.join('\n');
    await notify(text);

    await saveMetricsSnapshot('daily_report', {
      today: { spend: tSpend, clicks: tClicks, leads: tLeads, messages: tMsgs },
      yesterday: { spend: ySpend, leads: yLeads },
      month: { spend: mSpend },
    });

    console.log('[AdsManager] Daily report done');
  } catch (err) {
    console.error('[AdsManager] Daily report error:', err.message);
  }
}

// --- Anomaly Detection (every 2h business hours) ---
async function anomalyCheck() {
  console.log('[AdsManager] Running anomaly check...');

  try {
    const today = await getTodaySpend();
    if (!today?.data?.length) return;

    const ins = today.data[0];
    const spend = parseFloat(ins.spend || 0);
    const clicks = parseInt(ins.clicks || 0);

    if (!lastKnownMetrics || spend === 0) {
      lastKnownMetrics = { totalSpend: spend, totalClicks: clicks, date: new Date().toISOString() };
      return;
    }

    const alerts = [];

    // Spend spike compared to yesterday
    if (lastKnownMetrics.totalSpend > 0) {
      const spendRatio = (spend / lastKnownMetrics.totalSpend) * 100 - 100;
      if (spendRatio > THRESHOLDS.spendSpikePercent) {
        alerts.push(`Gasto hoje (${formatCurrency(spend)}) é ${spendRatio.toFixed(0)}% acima de ontem`);
      }
    }

    // Delivery issues — impressions but no clicks
    const impressions = parseInt(ins.impressions || 0);
    if (impressions > 500 && clicks === 0) {
      alerts.push(`${formatNumber(impressions)} impressões sem nenhum clique — possível problema de entrega`);
    }

    if (alerts.length > 0) {
      const text = `*[ADS] Alerta Anomalia*\n\n${alerts.map(a => `⚠ ${a}`).join('\n')}`;
      await notify(text);
    }
  } catch (err) {
    console.error('[AdsManager] Anomaly check error:', err.message);
  }
}


// --- Creative Fatigue Detection ---
async function creativeCheck() {
  console.log('[AdsManager] Running creative fatigue check...');

  try {
    // Get ad-level insights for last 3 days to detect trends
    const last3d = await metaGet(`${META_AD_ACCOUNT_ID}/insights`, {
      fields: 'ad_name,ad_id,adset_name,campaign_name,spend,impressions,clicks,ctr,cpc,reach,frequency,actions,date_start,date_stop',
      date_preset: 'last_3d',
      level: 'ad',
      time_increment: 1,
      limit: '100',
      filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]),
    });

    if (!last3d?.data?.length) return;

    // Group by ad_id
    const adMap = new Map();
    for (const row of last3d.data) {
      if (!adMap.has(row.ad_id)) adMap.set(row.ad_id, { name: row.ad_name, campaign: row.campaign_name, days: [] });
      adMap.get(row.ad_id).days.push({
        date: row.date_start,
        ctr: parseFloat(row.ctr || 0),
        cpc: parseFloat(row.cpc || 0),
        frequency: parseFloat(row.frequency || 0),
        reach: parseInt(row.reach || 0),
        impressions: parseInt(row.impressions || 0),
        spend: parseFloat(row.spend || 0),
      });
    }

    const alerts = [];

    for (const [adId, ad] of adMap) {
      const days = ad.days.sort((a, b) => a.date.localeCompare(b.date));
      if (days.length < 2) continue;

      const latest = days[days.length - 1];
      const previous = days[days.length - 2];
      const issues = [];

      // 1. Frequency too high
      if (latest.frequency > THRESHOLDS.frequencyMax) {
        issues.push(`Frequência ${latest.frequency.toFixed(1)}x (max: ${THRESHOLDS.frequencyMax})`);
      }

      // 2. CTR dropping >30%
      if (previous.ctr > 0 && latest.ctr > 0) {
        const ctrDrop = ((previous.ctr - latest.ctr) / previous.ctr) * 100;
        if (ctrDrop > 30) {
          issues.push(`CTR caiu ${ctrDrop.toFixed(0)}% (${formatPercent(previous.ctr)} → ${formatPercent(latest.ctr)})`);
        }
      }

      // 3. CPC increasing >40%
      if (previous.cpc > 0 && latest.cpc > 0) {
        const cpcIncrease = ((latest.cpc - previous.cpc) / previous.cpc) * 100;
        if (cpcIncrease > 40) {
          issues.push(`CPC subiu ${cpcIncrease.toFixed(0)}% (${formatCurrency(previous.cpc)} → ${formatCurrency(latest.cpc)})`);
        }
      }

      // 4. Reach stagnating (less than 10% growth)
      if (previous.reach > 100 && latest.reach > 0) {
        const reachGrowth = ((latest.reach - previous.reach) / previous.reach) * 100;
        if (reachGrowth < 5 && latest.frequency > 2) {
          issues.push(`Alcance estagnado (+${reachGrowth.toFixed(0)}%) com frequência ${latest.frequency.toFixed(1)}x`);
        }
      }

      if (issues.length > 0) {
        alerts.push({ name: ad.name, campaign: ad.campaign, issues });
      }
    }

    if (alerts.length > 0) {
      const lines = ['*[ADS] Alerta de Criativo*\n'];
      for (const alert of alerts) {
        lines.push(`*${alert.name}*`);
        lines.push(`Campanha: ${alert.campaign}`);
        for (const issue of alert.issues) {
          lines.push(`⚠ ${issue}`);
        }
        lines.push('');
      }
      lines.push('*Recomendação:* Trocar criativo ou público para evitar fadiga');
      await notify(lines.join('\n'));
    } else {
      console.log('[AdsManager] Creative check OK — no fatigue detected');
    }
  } catch (err) {
    console.error('[AdsManager] Creative check error:', err.message);
  }
}

// --- Public API for MCP/commands ---
export async function getAdsSnapshot() {
  const [campaigns, today, month] = await Promise.all([
    getCampaigns(),
    getTodaySpend(),
    getAccountSpend('this_month'),
  ]);
  return { campaigns: campaigns?.data, today: today?.data?.[0], month: month?.data?.[0] };
}

export async function getAdsCampaignDetails(campaignId) {
  return metaGet(`${campaignId}/insights`, {
    fields: 'campaign_name,spend,impressions,clicks,ctr,cpc,reach,frequency,actions,cost_per_action_type',
    date_preset: 'last_7d',
  });
}

export async function sendAdsReport() {
  await dailyReport();
}

// --- Token Refresh (proactive, every 50 days) ---
async function refreshToken() {
  if (!META_APP_ID || !META_APP_SECRET) {
    console.log('[AdsManager] No app credentials for token refresh');
    return;
  }

  try {
    const url = `${BASE_URL}/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${META_ACCESS_TOKEN}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.access_token) {
      // Note: In production, you'd update .env here
      console.log(`[AdsManager] Token refreshed, expires in ${Math.round(data.expires_in / 86400)} days`);
    }
  } catch (err) {
    console.error('[AdsManager] Token refresh error:', err.message);
    await notify('*[ADS] ⚠ Token Meta expirando em breve — precisa renovar manualmente*');
  }
}

// --- Scheduler ---
export function startAdsScheduler() {
  if (!META_ACCESS_TOKEN) {
    console.log('[AdsManager] META_ACCESS_TOKEN not set, ads manager disabled');
    return;
  }

  console.log('[AdsManager] Ads Manager ATIVADO — Monitor (08h/12h/18h) + Criativo (14h) + Anomaly (2h)');

  // 08:00 BRT = 11:00 UTC — Morning check
  cron.schedule('0 11 * * 1-6', () => morningCheck(), { timezone: 'UTC' });

  // 12:00 BRT = 15:00 UTC — Midday pulse
  cron.schedule('0 15 * * 1-6', () => middayPulse(), { timezone: 'UTC' });

  // 18:00 BRT = 21:00 UTC — Daily report
  cron.schedule('0 21 * * 1-6', () => dailyReport(), { timezone: 'UTC' });

  // Every 2h business hours (10-18 BRT = 13-21 UTC)
  cron.schedule('0 13,15,17,19,21 * * 1-6', () => anomalyCheck(), { timezone: 'UTC' });

  // 14:00 BRT = 17:00 UTC — Creative fatigue check
  cron.schedule('0 17 * * 1-6', () => creativeCheck(), { timezone: 'UTC' });

  // Token refresh check — every 50 days
  cron.schedule('0 12 1,21 * *', () => refreshToken(), { timezone: 'UTC' });

  // Initial check after 30s
  setTimeout(() => {
    getCampaigns().then(c => {
      const count = c?.data?.length || 0;
      console.log(`[AdsManager] Found ${count} campaigns`);
    }).catch(() => {});
  }, 30000);
}
