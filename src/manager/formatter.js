/**
 * Format Luan manager reports for WhatsApp and API.
 */

const PHASE_NAMES = {
  0: 'Antiban',
  1: 'Abordagem',
  2: 'Investigacao',
  3: 'Educacao',
  4: 'Dir. ao Site',
};

const PRIORITY_LABELS = {
  'qualificacao': 'Qualificacao',
  'fechamento': 'Fechamento',
  'pipeline': 'Pipeline',
  'follow-up': 'Follow-up',
};

function formatBRL(value) {
  const num = parseFloat(value) || 0;
  return 'R$ ' + num.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function trendArrow(direction) {
  if (direction === 'subindo') return '(+)';
  if (direction === 'caindo') return '(-)';
  return '(=)';
}

/**
 * Format the report for WhatsApp delivery.
 */
export function formatWhatsAppReport(metrics, aiRecommendations, reportType = 'daily') {
  const { conversions, health, bottlenecks, forecast, teamEval, priority, trends, revenue, pipeline, stale, calls, followups } = metrics;

  const title = reportType === 'weekly'
    ? 'RELATORIO SEMANAL DE PERFORMANCE'
    : reportType === 'daily'
    ? 'RELATORIO DIARIO DE PERFORMANCE'
    : 'RELATORIO DE PERFORMANCE';

  const now = new Date();
  const brt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dateStr = String(brt.getDate()).padStart(2, '0') + '/' + String(brt.getMonth() + 1).padStart(2, '0') + '/' + brt.getFullYear();

  const lines = [];

  // Header
  lines.push(title);
  lines.push(dateStr);
  lines.push('================================');
  lines.push('');

  // Resumo Geral
  lines.push('RESUMO GERAL');
  lines.push('Total de Leads: ' + (conversions.total || 0));
  lines.push('Leads Qualificados: ' + (conversions.qualified || 0) + ' (' + (conversions.qualificationRate || 0) + '%)');
  lines.push('Chegaram ao Site: ' + (conversions.reachedSite || 0) + ' (' + (conversions.siteRate || 0) + '%)');
  lines.push('Vendas Fechadas: ' + (conversions.paidOrders || 0));
  lines.push('Taxa de Conversao: ' + (conversions.overallRate || 0) + '%');
  lines.push('');

  // Receita
  lines.push('RECEITA');
  lines.push('Receita Total: ' + formatBRL(revenue?.revenue));
  lines.push('Receita Hoje: ' + formatBRL(revenue?.revenueToday));
  lines.push('Ticket Medio: ' + formatBRL(revenue?.avgTicket));
  lines.push('Pedidos Pagos: ' + (revenue?.paidOrders || 0));
  if (revenue?.byService?.length > 0) {
    for (const s of revenue.byService) {
      lines.push('- ' + capitalize(s.service) + ': ' + s.count + 'x (' + formatBRL(s.revenue) + ')');
    }
  }
  lines.push('');

  // Saude do Pipeline
  lines.push('SAUDE DO PIPELINE: ' + capitalize(health || 'indefinido'));
  lines.push('Valor no Pipeline: ' + formatBRL(pipeline?.totalValue));
  if (stale) {
    lines.push('Leads Esfriando: ' + (stale.total || 0) + ' (criticos: ' + (stale.critical || 0) + ')');
  }
  lines.push('');

  // Trends
  if (trends) {
    lines.push('TENDENCIAS vs PERIODO ANTERIOR');
    if (trends.leads) lines.push('- Leads: ' + trendArrow(trends.leads.direction) + ' ' + (trends.leads.change > 0 ? '+' : '') + trends.leads.change + '%');
    if (trends.revenue) lines.push('- Receita: ' + trendArrow(trends.revenue.direction) + ' ' + (trends.revenue.change > 0 ? '+' : '') + trends.revenue.change + '%');
    if (trends.conversion) lines.push('- Conversao: ' + trendArrow(trends.conversion.direction) + ' ' + (trends.conversion.change > 0 ? '+' : '') + trends.conversion.change + '%');
    lines.push('');
  }

  // Gargalos
  lines.push('GARGALOS IDENTIFICADOS');
  if (bottlenecks.length === 0) {
    lines.push('- Nenhum gargalo critico identificado');
  } else {
    for (const b of bottlenecks.slice(0, 3)) {
      lines.push('- [' + b.severity.toUpperCase() + '] ' + b.description + (b.owner ? ' (resp: ' + b.owner + ')' : ''));
    }
  }
  lines.push('');

  // AI Recommendations
  lines.push('ANALISE E RECOMENDACOES (AI)');
  if (aiRecommendations) {
    lines.push(aiRecommendations);
  } else {
    lines.push('- Indisponivel');
  }
  lines.push('');

  // Team Performance
  if (teamEval && Object.keys(teamEval).length > 0) {
    lines.push('PERFORMANCE DA EQUIPE');
    for (const [key, eval_] of Object.entries(teamEval)) {
      lines.push('- ' + eval_.name + ': ' + eval_.score.toUpperCase());
      lines.push('  ' + eval_.notes);
    }
    lines.push('');
  }

  // Calls & Follow-ups
  if (calls?.total > 0 || followups?.total > 0) {
    lines.push('OPERACOES');
    if (calls?.total > 0) {
      lines.push('- Ligacoes: ' + calls.completed + '/' + calls.total + ' completadas (' + calls.completionRate + '%)');
    }
    if (followups?.total > 0) {
      lines.push('- Follow-ups: ' + followups.sent + '/' + followups.total + ' enviados (' + followups.sendRate + '%)');
    }
    lines.push('');
  }

  // Forecast
  lines.push('PREVISAO DE RECEITA');
  lines.push('Confianca: ' + capitalize(forecast?.confidence || 'baixa'));
  lines.push('Estimativa: ' + formatBRL(forecast?.low) + ' a ' + formatBRL(forecast?.high));
  lines.push('Tendencia: ' + capitalize(forecast?.trend || 'estavel'));
  lines.push('');

  // Priority
  lines.push('PRIORIDADE ATUAL: ' + (PRIORITY_LABELS[priority] || capitalize(priority || 'qualificacao')));
  lines.push('================================');

  const fullText = lines.join('\n');

  // Split into multiple messages if too long for WhatsApp (4096 char limit)
  if (fullText.length <= 4000) {
    return [fullText];
  }

  return splitIntoMessages(fullText, 4000);
}

/**
 * Split a long text into WhatsApp-safe messages at natural break points.
 */
function splitIntoMessages(text, maxLen) {
  const messages = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Find a natural break point (double newline) before the limit
    let cutIndex = remaining.lastIndexOf('\n\n', maxLen);
    if (cutIndex < maxLen * 0.3) {
      // If no good break found, just cut at single newline
      cutIndex = remaining.lastIndexOf('\n', maxLen);
    }
    if (cutIndex < maxLen * 0.3) {
      cutIndex = maxLen;
    }

    messages.push(remaining.substring(0, cutIndex).trim());
    remaining = remaining.substring(cutIndex).trim();
  }

  if (remaining.length > 0) {
    messages.push(remaining);
  }

  return messages;
}

/**
 * Format for API JSON response.
 */
export function formatAPIResponse(metrics, aiRecommendations) {
  const { conversions, health, bottlenecks, forecast, teamEval, priority, trends, revenue, pipeline, stale, calls, followups } = metrics;

  return {
    timestamp: new Date().toISOString(),
    summary: {
      totalLeads: conversions.total,
      qualifiedLeads: conversions.qualified,
      reachedSite: conversions.reachedSite,
      paidOrders: conversions.paidOrders,
      conversionRate: conversions.overallRate,
      qualificationRate: conversions.qualificationRate,
      closingRate: conversions.closingRate,
    },
    revenue: {
      total: revenue?.revenue || 0,
      today: revenue?.revenueToday || 0,
      avgTicket: revenue?.avgTicket || 0,
      byService: revenue?.byService || [],
    },
    pipeline: {
      health,
      totalValue: pipeline?.totalValue || 0,
      totalLeads: pipeline?.totalLeads || 0,
      staleLeads: stale,
    },
    bottlenecks,
    forecast,
    teamPerformance: teamEval,
    operations: {
      calls: calls || {},
      followups: followups || {},
    },
    trends,
    priority,
    aiRecommendations,
  };
}
