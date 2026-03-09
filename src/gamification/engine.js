import { db } from '../db/client.js';

// Level definitions (must match frontend)
const LEVELS = [
  { name: 'Endividado', cpMin: 0, scoreMin: null, rating: null },
  { name: 'Organizando', cpMin: 100, scoreMin: 300, rating: 'C' },
  { name: 'Evoluindo', cpMin: 350, scoreMin: 500, rating: 'B' },
  { name: 'Estratégico', cpMin: 750, scoreMin: 700, rating: 'A' },
  { name: 'Premium Black', cpMin: 1500, scoreMin: 900, rating: 'A+' },
];

// Task definitions with CP rewards
const TASKS = {
  'diagnostico_rating': { name: 'Pagar Diagnóstico de Rating', cp: 40, level: 1 },
  'modulo_1_assistir': { name: 'Assistir Módulo 1', cp: 30, level: 1 },
  'modulo_1_questoes': { name: 'Fazer questões do Módulo 1', cp: 30, level: 1 },
  'pagar_rating': { name: 'Pagar Rating', cp: 50, level: 2 },
  'limpa_nome': { name: 'Pagar Limpa Nome', cp: 80, level: 2 },
  'modulo_2_assistir': { name: 'Assistir Módulo 2', cp: 60, level: 2 },
  'modulo_2_questoes': { name: 'Fazer questões do Módulo 2', cp: 60, level: 2 },
  'diagnostico_bacen': { name: 'Pagar Diagnóstico de BACEN', cp: 100, level: 3 },
  'quitar_dividas': { name: 'Quitar primeiras dívidas', cp: 150, level: 3 },
  'modulo_3_assistir': { name: 'Assistir Módulo 3', cp: 75, level: 3 },
  'modulo_3_questoes': { name: 'Fazer questões do Módulo 3', cp: 75, level: 3 },
  'aumento_bacen': { name: 'PF: Pagar Aumento BACEN', cp: 300, level: 4 },
  'consultoria_pronampe': { name: 'PJ: Consultoria Avançada PRONAMPE', cp: 300, level: 4 },
  'modulo_4_assistir': { name: 'Assistir Módulo 4', cp: 100, level: 4 },
  'modulo_4_questoes': { name: 'Fazer questões do Módulo 4', cp: 100, level: 4 },
  'credito_aprovado': { name: 'Resultados de crédito aprovados', cp: 250, level: 4 },
};

/**
 * Ensure user_gamification row exists for CPF
 */
export async function ensureGamification(cpf) {
  const cleanCpf = cpf.replace(/[^0-9]/g, '');
  const { rows } = await db.query(
    'SELECT * FROM user_gamification WHERE cpf = $1', [cleanCpf]
  );
  if (rows[0]) return rows[0];

  const { rows: newRows } = await db.query(
    `INSERT INTO user_gamification (cpf) VALUES ($1)
     ON CONFLICT (cpf) DO NOTHING
     RETURNING *`, [cleanCpf]
  );
  if (newRows[0]) return newRows[0];

  // Race condition fallback
  const { rows: fallback } = await db.query(
    'SELECT * FROM user_gamification WHERE cpf = $1', [cleanCpf]
  );
  return fallback[0];
}

/**
 * Complete a task and award CP
 */
export async function completeTask(cpf, taskId) {
  const cleanCpf = cpf.replace(/[^0-9]/g, '');
  const task = TASKS[taskId];
  if (!task) {
    console.warn(`[Gamification] Unknown task: ${taskId}`);
    return null;
  }

  const gam = await ensureGamification(cleanCpf);
  const completedTasks = gam.tarefas_completas || [];

  // Don't award CP twice for same task
  if (completedTasks.includes(taskId)) {
    console.log(`[Gamification] Task "${taskId}" already completed for CPF ${cleanCpf.substring(0, 3)}***`);
    return gam;
  }

  const newCp = gam.cp_total + task.cp;
  const newTasks = [...completedTasks, taskId];
  const newLevel = calculateLevel(newCp);

  const { rows } = await db.query(
    `UPDATE user_gamification
     SET cp_total = $1, tarefas_completas = $2::jsonb, nivel = $3, updated_at = NOW()
     WHERE cpf = $4 RETURNING *`,
    [newCp, JSON.stringify(newTasks), newLevel, cleanCpf]
  );

  console.log(`[Gamification] Task "${taskId}" completed: +${task.cp} CP (total: ${newCp}) for CPF ${cleanCpf.substring(0, 3)}***`);
  return rows[0];
}

/**
 * Process diagnostico completion — extract rating data and award CP
 */
export async function processDiagnosticoCompleted(cpf, apifulResponse) {
  const cleanCpf = cpf.replace(/[^0-9]/g, '');
  await ensureGamification(cleanCpf);

  // Extract rating data from Apiful response if available
  let rating = null;
  let scoreEstimado = null;
  let dividasTotal = 0;

  if (apifulResponse && apifulResponse.dados) {
    const dados = apifulResponse.dados;

    // Try to extract score/rating from SCPC data
    if (dados.score) scoreEstimado = parseInt(dados.score) || null;
    if (dados.rating) rating = dados.rating;
    if (dados.scoreClasse) rating = dados.scoreClasse;

    // Count pendencias/restricoes as dividas
    if (dados.restricoes && Array.isArray(dados.restricoes)) {
      dividasTotal = dados.restricoes.length;
    }
    if (dados.pendenciasFinanceiras && Array.isArray(dados.pendenciasFinanceiras)) {
      dividasTotal += dados.pendenciasFinanceiras.length;
    }
    if (dados.quantidadeRestricoes) {
      dividasTotal = parseInt(dados.quantidadeRestricoes) || dividasTotal;
    }
  }

  // If no rating from API, estimate based on score
  if (!rating) {
    if (scoreEstimado >= 900) rating = 'A+';
    else if (scoreEstimado >= 700) rating = 'A';
    else if (scoreEstimado >= 500) rating = 'B';
    else if (scoreEstimado >= 300) rating = 'C';
    else rating = 'D';
  }

  // Update gamification with diagnostico data
  await db.query(
    `UPDATE user_gamification
     SET rating = $1, score_estimado = $2, dividas_total = $3,
         diagnostico_completo = true, updated_at = NOW()
     WHERE cpf = $4`,
    [rating, scoreEstimado, dividasTotal, cleanCpf]
  );

  // Award CP for completing the diagnostico task
  await completeTask(cleanCpf, 'diagnostico_rating');

  console.log(`[Gamification] Diagnostico processed: rating=${rating}, score=${scoreEstimado}, dividas=${dividasTotal} for CPF ${cleanCpf.substring(0, 3)}***`);

  return { rating, scoreEstimado, dividasTotal };
}

/**
 * Award CP when user pays for a service (maps service name to task)
 */
export async function processServicePurchase(cpf, serviceName) {
  const cleanCpf = cpf.replace(/[^0-9]/g, '');
  const svcLower = (serviceName || '').toLowerCase();

  // Map service names to task IDs
  const serviceTaskMap = {
    'diagnóstico de rating': 'diagnostico_rating',
    'diagnostico de rating': 'diagnostico_rating',
    'rating': 'pagar_rating',
    'limpa nome': 'limpa_nome',
    'diagnóstico de bacen': 'diagnostico_bacen',
    'diagnostico de bacen': 'diagnostico_bacen',
    'aumento bacen': 'aumento_bacen',
    'consultoria pronampe': 'consultoria_pronampe',
  };

  for (const [key, taskId] of Object.entries(serviceTaskMap)) {
    if (svcLower.includes(key)) {
      return await completeTask(cleanCpf, taskId);
    }
  }

  console.log(`[Gamification] No task mapping for service: "${serviceName}"`);
  return null;
}

/**
 * Calculate level based on CP
 */
function calculateLevel(cp) {
  let level = LEVELS[0].name;
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (cp >= LEVELS[i].cpMin) { level = LEVELS[i].name; break; }
  }
  return level;
}

/**
 * Get full gamification data for a user
 */
export async function getGamificationData(cpf) {
  const cleanCpf = cpf.replace(/[^0-9]/g, '');
  const gam = await ensureGamification(cleanCpf);

  const currentLevel = LEVELS.find(l => l.name === gam.nivel) || LEVELS[0];
  const currentIdx = LEVELS.indexOf(currentLevel);
  const nextLevel = LEVELS[currentIdx + 1] || currentLevel;

  return {
    nivel_atual: gam.nivel,
    xp_atual: gam.cp_total,
    xp_maximo: nextLevel.cpMin,
    rating: gam.rating || '--',
    score_estimado: gam.score_estimado,
    dividas_total: gam.dividas_total,
    dividas_quitadas: gam.dividas_quitadas,
    diagnostico_completo: gam.diagnostico_completo,
    tarefas_completas: gam.tarefas_completas || [],
    desconto_ativo: gam.cp_total >= 750 ? 10 : gam.cp_total >= 350 ? 5 : 0,
    streak_dias: 0,
    xp_mes_atual: gam.cp_total, // simplified for now
    meta_mes: currentLevel === LEVELS[0] ? 100 : nextLevel.cpMin,
  };
}

export { LEVELS, TASKS };
