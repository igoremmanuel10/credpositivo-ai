/**
 * Pure calculation functions for Luan manager agent.
 * No DB calls, no side effects — only math.
 */

const PHASE_NAMES = {
  0: 'Antiban',
  1: 'Abordagem',
  2: 'Investigacao',
  3: 'Educacao',
  4: 'Dir. ao Site',
};

/**
 * Calculate conversion rates from funnel data.
 */
export function calculateConversionRates(funnel, revenue) {
  const total = funnel.total || 0;
  const phases = funnel.phases || [];

  // Qualified = phase 2+ (passed investigation)
  const qualified = phases
    .filter(p => p.phase >= 2)
    .reduce((sum, p) => sum + p.count, 0);

  // Reached site = phase 4+
  const reachedSite = phases
    .filter(p => p.phase >= 4)
    .reduce((sum, p) => sum + p.count, 0);

  const paidOrders = revenue?.paidOrders || 0;

  const qualificationRate = total > 0
    ? Math.round((qualified / total) * 1000) / 10
    : 0;

  const siteRate = qualified > 0
    ? Math.round((reachedSite / qualified) * 1000) / 10
    : 0;

  const closingRate = reachedSite > 0
    ? Math.round((paidOrders / reachedSite) * 1000) / 10
    : 0;

  const overallRate = total > 0
    ? Math.round((paidOrders / total) * 1000) / 10
    : 0;

  return {
    total,
    qualified,
    reachedSite,
    paidOrders,
    qualificationRate,
    siteRate,
    closingRate,
    overallRate,
  };
}

/**
 * Assess pipeline health: 'forte' | 'moderado' | 'fraco'
 */
export function assessPipelineHealth(metrics) {
  const { conversions, stale, pipeline, revenue } = metrics;

  let score = 0;

  // Conversion rate scoring
  if (conversions.overallRate >= 5) score += 3;
  else if (conversions.overallRate >= 2) score += 2;
  else if (conversions.overallRate >= 1) score += 1;

  // Stale leads scoring (lower is better)
  const staleTotal = stale?.total || 0;
  const totalLeads = pipeline?.totalLeads || 1;
  const stalePercent = (staleTotal / totalLeads) * 100;
  if (stalePercent < 10) score += 2;
  else if (stalePercent < 25) score += 1;

  // Revenue scoring
  if (revenue?.paidOrders >= 5) score += 2;
  else if (revenue?.paidOrders >= 1) score += 1;

  // Volume scoring
  if (totalLeads >= 50) score += 1;

  if (score >= 6) return 'forte';
  if (score >= 3) return 'moderado';
  return 'fraco';
}

/**
 * Detect bottlenecks in the funnel.
 * Returns array of identified bottlenecks sorted by severity.
 */
export function detectBottlenecks(funnel, conversions, stale, revenue) {
  const bottlenecks = [];

  // Phase-to-phase dropoff analysis
  const phases = funnel.phases || [];
  for (let i = 1; i < phases.length; i++) {
    if (phases[i].dropoff_rate > 60 && phases[i - 1].count >= 5) {
      bottlenecks.push({
        type: 'funnel_dropoff',
        from: phases[i - 1].phase,
        to: phases[i].phase,
        fromName: PHASE_NAMES[phases[i - 1].phase] || 'Fase ' + phases[i - 1].phase,
        toName: PHASE_NAMES[phases[i].phase] || 'Fase ' + phases[i].phase,
        dropoffRate: phases[i].dropoff_rate,
        severity: phases[i].dropoff_rate > 80 ? 'critico' : 'alto',
        description: `${Math.round(phases[i].dropoff_rate)}% dos leads perdidos entre ${PHASE_NAMES[phases[i - 1].phase] || 'Fase ' + phases[i - 1].phase} e ${PHASE_NAMES[phases[i].phase] || 'Fase ' + phases[i].phase}`,
      });
    }
  }

  // SDR bottleneck: lots of leads but few qualified
  if (conversions.qualificationRate < 20 && conversions.total >= 10) {
    bottlenecks.push({
      type: 'sdr_qualification',
      severity: conversions.qualificationRate < 10 ? 'critico' : 'alto',
      description: `Taxa de qualificacao baixa: ${conversions.qualificationRate}% (${conversions.qualified}/${conversions.total})`,
      owner: 'Augusto',
    });
  }

  // Closer bottleneck: lots of qualified but few closings
  if (conversions.closingRate < 15 && conversions.reachedSite >= 3) {
    bottlenecks.push({
      type: 'closer_conversion',
      severity: conversions.closingRate < 5 ? 'critico' : 'alto',
      description: `Taxa de fechamento baixa: ${conversions.closingRate}% (${conversions.paidOrders}/${conversions.reachedSite} que chegaram ao site)`,
      owner: 'Paulo',
    });
  }

  // Stale leads bottleneck
  const staleTotal = stale?.total || 0;
  if (staleTotal >= 10) {
    bottlenecks.push({
      type: 'stale_leads',
      severity: stale.critical >= 5 ? 'critico' : 'alto',
      description: `${staleTotal} leads esfriando sem contato (${stale.critical || 0} criticos >72h)`,
      owner: 'Ana',
    });
  }

  // No revenue bottleneck
  if (revenue?.paidOrders === 0 && conversions.total >= 10) {
    bottlenecks.push({
      type: 'zero_revenue',
      severity: 'critico',
      description: `Nenhuma venda fechada com ${conversions.total} leads no periodo`,
      owner: 'Equipe',
    });
  }

  // Sort by severity
  const severityOrder = { critico: 0, alto: 1, medio: 2 };
  bottlenecks.sort((a, b) => (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2));

  return bottlenecks.slice(0, 5);
}

/**
 * Forecast revenue for the coming period.
 */
export function forecastRevenue(pipeline, conversions, revenue, previousReport) {
  const pipelineValue = pipeline?.totalValue || 0;
  const rate = (conversions?.overallRate || 0) / 100;
  const currentRevenue = revenue?.revenue || 0;

  // Simple forecast based on pipeline value * conversion rate
  const low = Math.round(pipelineValue * rate * 0.5);
  const medium = Math.round(pipelineValue * rate);
  const high = Math.round(pipelineValue * rate * 1.5);

  // Confidence based on data volume
  let confidence = 'baixa';
  if (pipeline?.totalLeads >= 50 && revenue?.paidOrders >= 5) {
    confidence = 'alta';
  } else if (pipeline?.totalLeads >= 20 && revenue?.paidOrders >= 1) {
    confidence = 'media';
  }

  // Trend vs previous report
  let trend = 'estavel';
  if (previousReport?.metrics) {
    const prevRevenue = previousReport.metrics.revenue?.revenue || 0;
    if (currentRevenue > prevRevenue * 1.1) trend = 'subindo';
    else if (currentRevenue < prevRevenue * 0.9) trend = 'caindo';
  }

  return { low, medium, high, confidence, trend, pipelineValue };
}

/**
 * Evaluate team performance.
 */
export function evaluateTeam(teamData) {
  const evaluations = {};

  // Augusto (SDR)
  const augusto = teamData.augusto;
  if (augusto) {
    const score = augusto.qualificationRate >= 30 ? 'bom'
      : augusto.qualificationRate >= 15 ? 'regular'
      : 'precisa melhorar';

    evaluations.augusto = {
      name: 'Augusto (SDR)',
      conversations: augusto.totalConversations,
      qualified: augusto.qualified,
      qualificationRate: augusto.qualificationRate,
      lossRate: augusto.lossRate,
      score,
      notes: augusto.qualificationRate < 15
        ? 'Qualificacao abaixo de 15%. Revisar script de investigacao.'
        : augusto.lossRate > 30
        ? 'Taxa de perda alta (' + augusto.lossRate + '%). Revisar abordagem inicial.'
        : 'Performance dentro do esperado.',
    };
  }

  // Paulo (Closer)
  const paulo = teamData.paulo || teamData.paulo_sdr;
  if (paulo) {
    const score = paulo.siteRate >= 20 ? 'bom'
      : paulo.siteRate >= 10 ? 'regular'
      : 'precisa melhorar';

    evaluations.paulo = {
      name: 'Paulo (Closer)',
      conversations: paulo.totalConversations,
      reachedSite: paulo.reachedSite,
      siteRate: paulo.siteRate,
      lossRate: paulo.lossRate,
      score,
      notes: paulo.siteRate < 10
        ? 'Poucos leads chegando ao site. Revisar tratamento de objecoes.'
        : paulo.lossRate > 40
        ? 'Taxa de perda alta (' + paulo.lossRate + '%). Verificar script de fechamento.'
        : 'Performance dentro do esperado.',
    };
  }

  return evaluations;
}

/**
 * Determine current priority action.
 */
export function determinePriority(metrics) {
  const { conversions, stale, pipeline, funnel } = metrics;

  // Priority 1: If no leads coming in, focus on pipeline
  if ((pipeline?.totalLeads || 0) < 5) return 'pipeline';

  // Priority 2: If lots of stale leads, focus on follow-up
  if ((stale?.total || 0) >= 10) return 'follow-up';

  // Priority 3: If qualification is broken, fix SDR
  if (conversions.qualificationRate < 15 && conversions.total >= 10) return 'qualificacao';

  // Priority 4: If qualified leads but no closings
  if (conversions.closingRate < 10 && conversions.reachedSite >= 3) return 'fechamento';

  // Default: focus on qualification improvement
  return 'qualificacao';
}

/**
 * Calculate trends vs previous period.
 */
export function calculateTrends(current, previous) {
  if (!previous) return null;

  const trends = {};

  const compare = (label, curr, prev) => {
    if (prev === 0 && curr === 0) return { label, direction: 'estavel', change: 0 };
    if (prev === 0) return { label, direction: 'subindo', change: 100 };
    const change = Math.round(((curr - prev) / prev) * 100);
    const direction = change > 5 ? 'subindo' : change < -5 ? 'caindo' : 'estavel';
    return { label, direction, change };
  };

  trends.leads = compare(
    'Leads',
    current.conversions?.total || 0,
    previous.conversions?.total || 0
  );

  trends.revenue = compare(
    'Receita',
    current.revenue?.revenue || 0,
    previous.revenue?.revenue || 0
  );

  trends.conversion = compare(
    'Conversao',
    current.conversions?.overallRate || 0,
    previous.conversions?.overallRate || 0
  );

  return trends;
}
