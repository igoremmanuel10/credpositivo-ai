/**
 * Alex DevOps agent — WhatsApp report and alert formatting.
 */

/**
 * Format the daily DevOps report for WhatsApp.
 */
export function formatDailyReport(health, errors24h, fixes24h, costs, aiDiagnosis) {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const dateStr = brt.toISOString().split('T')[0].split('-').reverse().join('/');

  const lines = [];
  lines.push('RELATORIO DEVOPS - ALEX');
  lines.push(dateStr);
  lines.push('================================');
  lines.push('');

  // Overall health
  lines.push('SAUDE DO SISTEMA: ' + (health?.overall || 'DESCONHECIDO'));
  lines.push('');

  // Services
  lines.push('SERVICOS:');
  if (health?.services) {
    for (const svc of health.services) {
      if (svc.service === 'api_costs' || svc.service === 'process') continue;
      const time = svc.responseTimeMs ? ` (${svc.responseTimeMs}ms)` : '';
      const err = svc.error ? ` - ${svc.error}` : '';
      lines.push(`- ${formatServiceName(svc.service)}: ${svc.status.toUpperCase()}${time}${err}`);
    }
  }
  lines.push('');

  // Process info
  const proc = health?.services?.find(s => s.service === 'process');
  if (proc?.details) {
    lines.push('PROCESSO:');
    lines.push(`- Memoria: ${proc.details.heapUsedMB}MB heap / ${proc.details.rssMB}MB RSS`);
    lines.push(`- Uptime: ${proc.details.uptimeHours}h`);
    lines.push('');
  }

  // Errors
  const totalErrors = errors24h.reduce((s, e) => s + (e.count || 1), 0);
  if (totalErrors > 0) {
    lines.push('ERROS NAS ULTIMAS 24H (' + totalErrors + ' total):');
    // Group by category
    const byCategory = {};
    for (const err of errors24h) {
      if (!byCategory[err.category]) byCategory[err.category] = [];
      byCategory[err.category].push(err);
    }
    for (const [cat, errs] of Object.entries(byCategory)) {
      const count = errs.reduce((s, e) => s + (e.count || 1), 0);
      const sample = errs[0].message.substring(0, 80);
      lines.push(`- [${cat}] ${sample} (${count}x)`);
    }
  } else {
    lines.push('ERROS NAS ULTIMAS 24H: Nenhum');
  }
  lines.push('');

  // Auto-fixes
  if (fixes24h && fixes24h.length > 0) {
    lines.push('CORRECOES AUTOMATICAS:');
    for (const fix of fixes24h) {
      lines.push(`- ${formatFixType(fix.type)}: ${fix.fixed} corrigido(s)`);
    }
  } else {
    lines.push('CORRECOES AUTOMATICAS: Nenhuma necessaria');
  }
  lines.push('');

  // API costs
  if (costs) {
    lines.push('CUSTOS API:');
    lines.push(`- Hoje: $${costs.todayUSD?.toFixed(2) || '0.00'} | Semana: $${costs.weekUSD?.toFixed(2) || '0.00'}`);
    lines.push('');
  }

  // AI Diagnosis
  if (aiDiagnosis) {
    lines.push('DIAGNOSTICO AI:');
    lines.push(aiDiagnosis);
  }
  lines.push('================================');

  return lines.join('\n');
}

/**
 * Format an instant critical alert for WhatsApp.
 */
export function formatCriticalAlert(service, error, recommendation) {
  const lines = [];
  lines.push('ALERTA ALEX - CRITICO');
  lines.push(formatServiceName(service) + ' DOWN');
  lines.push('Erro: ' + (error || 'Desconhecido'));
  if (recommendation) {
    lines.push('Acao: ' + recommendation);
  }
  return lines.join('\n');
}

/**
 * Format a cycle summary for JSON API response.
 */
export function formatCycleJSON(health, errors, fixes, aiDiagnosis) {
  return {
    timestamp: new Date().toISOString(),
    overall: health?.overall || 'UNKNOWN',
    services: health?.services || [],
    recentErrors: errors.length,
    autoFixes: fixes.length,
    diagnosis: aiDiagnosis || null,
  };
}

function formatServiceName(service) {
  const names = {
    postgres: 'PostgreSQL',
    redis: 'Redis',
    quepasa: 'Quepasa (WhatsApp)',
    chatwoot: 'Chatwoot (CRM)',
    bridge: 'Bridge',
    process: 'Processo Node.js',
    api_costs: 'Custos API',
  };
  return names[service] || service;
}

function formatFixType(type) {
  const labels = {
    clear_stuck_locks: 'Locks Redis removidas',
    reset_stuck_conversations: 'Conversas resetadas',
    cancel_orphaned_followups: 'Followups orfaos cancelados',
    clear_stuck_debounce: 'Buffers debounce limpos',
  };
  return labels[type] || type;
}
