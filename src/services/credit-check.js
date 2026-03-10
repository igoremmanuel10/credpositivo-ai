/**
 * Credit Check Service — consulta previa de CPF para o fluxo conversacional.
 *
 * Usa a API Apiful (ja configurada) para buscar dados basicos do CPF.
 * Retorna um resumo estruturado que o Augusto pode usar na conversa.
 *
 * IMPORTANTE: Essa consulta e feita ANTES da venda, durante a qualificacao (Fase 1).
 * E a versao "leve" — dados cadastrais + situacao. O relatorio completo (SCPC BV Plus)
 * so e gerado apos o pagamento.
 */

import { config } from '../config.js';
import { redis } from '../db/redis.js';

// Cache de consultas para evitar cobranças duplicadas (24h TTL)
const CACHE_TTL = 86400; // 24 horas

/**
 * Valida formato de CPF (11 digitos, nao sequencial)
 * @param {string} text - texto para extrair CPF
 * @returns {string|null} CPF limpo (11 digitos) ou null
 */
export function extractCPF(text) {
  if (!text) return null;

  // Padroes aceitos: 123.456.789-00, 12345678900, 123 456 789 00
  const match = text.match(/(\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\-\s]?\d{2})/);
  if (match) {
    const clean = match[1].replace(/[^0-9]/g, '');
    if (clean.length === 11 && !isSequential(clean)) {
      return clean;
    }
  }

  return null;
}

function isSequential(cpf) {
  return /^(\d)\1{10}$/.test(cpf);
}

/**
 * Consulta dados basicos do CPF via Apiful.
 * Retorna resumo estruturado para uso na conversa.
 *
 * @param {string} cpf - CPF limpo (11 digitos)
 * @returns {Promise<object>}
 */
export async function quickCreditCheck(cpf) {
  const cleanCpf = cpf.replace(/[^0-9]/g, '');

  // Check cache first
  const cacheKey = 'credit_check:' + cleanCpf;
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      console.log('[CreditCheck] Cache hit for CPF ' + cleanCpf.substring(0, 3) + '***');
      return parsed;
    } catch (e) { /* ignore parse errors */ }
  }

  const token = config.apiful.token;
  if (!token || token === 'PLACEHOLDER_SET_FULL_TOKEN_HERE') {
    console.error('[CreditCheck] Apiful token not configured');
    return { success: false, error: 'API nao configurada' };
  }

  try {
    const url = config.apiful.baseUrl + '/api/pf-dadosbasicos';

    console.log('[CreditCheck] Querying CPF ' + cleanCpf.substring(0, 3) + '***');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({ cpf: cleanCpf, link: 'pf-dadosbasicos' }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('[CreditCheck] API error ' + response.status + ': ' + text.substring(0, 200));
      return { success: false, error: 'Erro na consulta (' + response.status + ')' };
    }

    const apiData = await response.json();

    if (apiData.status !== 'sucesso' && !apiData.dados) {
      console.error('[CreditCheck] API returned non-success:', JSON.stringify(apiData).substring(0, 200));
      return { success: false, error: 'Dados nao encontrados' };
    }

    const dados = apiData.dados || apiData;
    const result = formatCreditSummary(cleanCpf, dados);

    // Cache result
    await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);

    return result;

  } catch (err) {
    console.error('[CreditCheck] Error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Formata dados da API em resumo legivel para a conversa.
 */
function formatCreditSummary(cpf, dados) {
  const nome = dados.nome || dados.nomeCompleto || '';
  const situacao = dados.situacaoRfb || dados.situacaoCadastral || '';
  const dataNasc = dados.dataNascimento || '';

  // Tenta extrair dados financeiros se disponiveis
  const negativacoes = dados.negativacoes || dados.restricoes || [];
  const protestos = dados.protestos || [];
  const score = dados.score || dados.scoreCredito || null;
  const pendencias = dados.pendencias || dados.pendenciasFinanceiras || [];

  const qtdNegativacoes = Array.isArray(negativacoes) ? negativacoes.length : (typeof negativacoes === 'number' ? negativacoes : 0);
  const qtdProtestos = Array.isArray(protestos) ? protestos.length : (typeof protestos === 'number' ? protestos : 0);
  const qtdPendencias = Array.isArray(pendencias) ? pendencias.length : (typeof pendencias === 'number' ? pendencias : 0);

  // Calcula valor total de negativacoes se disponivel
  let valorTotal = 0;
  if (Array.isArray(negativacoes)) {
    valorTotal = negativacoes.reduce(function(sum, neg) {
      const val = parseFloat(neg.valor || neg.value || 0);
      return sum + val;
    }, 0);
  }

  // Monta resumo para o prompt do Augusto
  const summaryParts = [];
  if (nome) summaryParts.push('Nome: ' + nome.split(' ')[0]); // So primeiro nome
  if (situacao) summaryParts.push('Situacao RFB: ' + situacao);
  if (score) summaryParts.push('Score: ' + score);
  if (qtdNegativacoes > 0) {
    summaryParts.push('Negativacoes: ' + qtdNegativacoes + (valorTotal > 0 ? ' (total R$' + valorTotal.toFixed(2).replace('.', ',') + ')' : ''));
  }
  if (qtdProtestos > 0) summaryParts.push('Protestos: ' + qtdProtestos);
  if (qtdPendencias > 0) summaryParts.push('Pendencias: ' + qtdPendencias);

  const summary = summaryParts.length > 0
    ? summaryParts.join(' | ')
    : 'Dados cadastrais encontrados (detalhes no diagnostico completo)';

  return {
    success: true,
    summary: summary,
    data: {
      nome: nome,
      situacao: situacao,
      score: score,
      negativacoes: qtdNegativacoes,
      valorTotal: valorTotal,
      protestos: qtdProtestos,
      pendencias: qtdPendencias,
      raw: dados,
    },
  };
}
