import { config } from '../config.js';
import PDFDocument from 'pdfkit';
import { createWriteStream, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

const PDF_DIR = '/data/diagnosticos';

/**
 * Consult credit data via Apiful API
 * Tries SCPC BV Plus first, falls back to basic data if no balance
 */
export async function consultaSCPC(cpf) {
  const token = config.apiful.token;
  if (!token || token === 'PLACEHOLDER_SET_FULL_TOKEN_HERE') {
    throw new Error('Apiful token not configured');
  }

  const cleanCpf = cpf.replace(/[^0-9]/g, '');
  const url = `${config.apiful.baseUrl}/api/pf-dadosbasicos`;

  // Try SCPC BV Plus V2 first (paid consultation)
  const scpcLinks = ['scpc-bv-plus'];

  for (const link of scpcLinks) {
    console.log(`[Apiful] Trying link="${link}" for CPF ${cleanCpf.substring(0, 3)}***`);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cpf: cleanCpf, link }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.status === 'sucesso') {
          console.log(`[Apiful] Success with link="${link}"`);
          return { ...data, consultationType: link };
        }
      }

      const text = await response.text();
      console.log(`[Apiful] link="${link}" returned ${response.status}: ${text.substring(0, 100)}`);

      // If "Sem saldo", try next link
      if (text.includes('Sem saldo')) continue;
      // Other error, try next
    } catch (err) {
      console.log(`[Apiful] link="${link}" error: ${err.message}`);
    }
  }

  // Fallback: basic CPF data (usually free/cheaper)
  console.log(`[Apiful] Falling back to pf-dadosbasicos for CPF ${cleanCpf.substring(0, 3)}***`);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cpf: cleanCpf, link: 'pf-dadosbasicos' }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[Apiful] Fallback error ${response.status}: ${text}`);
    throw new Error(`Apiful API error: ${response.status}`);
  }

  const data = await response.json();
  console.log('[Apiful] Basic consultation successful');
  return { ...data, consultationType: 'pf-dadosbasicos' };
}

/**
 * Generate a PDF report from Apiful response
 */
export async function generatePDF(diagnosticoId, cpf, apifulData) {
  if (!existsSync(PDF_DIR)) {
    mkdirSync(PDF_DIR, { recursive: true });
  }

  const filePath = resolve(PDF_DIR, `diagnostico-${diagnosticoId}.pdf`);
  const consultationType = apifulData.consultationType || 'Consulta';
  const dados = apifulData.dados || apifulData;

  return new Promise((resolvePromise, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = createWriteStream(filePath);

    doc.pipe(stream);

    // Header
    doc.fontSize(22).fillColor('#1a56db')
      .text('CredPositivo', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(16).fillColor('#333')
      .text('Diagnóstico de Crédito', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#666')
      .text(`Consulta: ${consultationType} | CPF: ${formatCPF(cpf)}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor('#999')
      .text(`Gerado em: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, { align: 'center' });

    // Separator
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').stroke();
    doc.moveDown(1);

    // Data sections
    if (dados) {
      renderSection(doc, 'Dados do Titular', dados);
    } else {
      doc.fontSize(12).fillColor('#666')
        .text('Dados da consulta não disponíveis.', { align: 'center' });
    }

    // Footer
    doc.moveDown(2);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').stroke();
    doc.moveDown(0.5);
    doc.fontSize(8).fillColor('#999')
      .text('Este documento é confidencial e destinado exclusivamente ao titular do CPF consultado.', { align: 'center' });
    doc.text('CredPositivo - credpositivo.com', { align: 'center' });

    doc.end();

    stream.on('finish', () => resolvePromise(filePath));
    stream.on('error', reject);
  });
}

function renderSection(doc, title, data, depth = 0) {
  const indent = 50 + depth * 20;

  if (title && depth === 0) {
    doc.fontSize(14).fillColor('#1a56db').text(title, indent);
    doc.moveDown(0.5);
  }

  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    doc.fontSize(10).fillColor('#333').text(String(data), indent);
    doc.moveDown(0.3);
    return;
  }

  if (Array.isArray(data)) {
    data.forEach((item, i) => {
      if (typeof item === 'object' && item !== null) {
        doc.fontSize(10).fillColor('#666').text(`Item ${i + 1}:`, indent);
        doc.moveDown(0.2);
        renderSection(doc, null, item, depth + 1);
      } else {
        doc.fontSize(10).fillColor('#333').text(`• ${item}`, indent);
        doc.moveDown(0.2);
      }
    });
    return;
  }

  if (typeof data === 'object' && data !== null) {
    for (const [key, value] of Object.entries(data)) {
      // Better labels for known fields
      const labelMap = {
        cpf: 'CPF', nome: 'Nome', sexo: 'Sexo', dataNascimento: 'Data de Nascimento',
        nomeMae: 'Nome da Mãe', situacaoRfb: 'Situação na Receita Federal',
        dataInscricao: 'Data de Inscrição', digitoVerificador: 'Dígito Verificador',
      };
      const label = labelMap[key] || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

      if (typeof value === 'object' && value !== null) {
        doc.fontSize(11).fillColor('#444').text(`${label}:`, indent);
        doc.moveDown(0.2);
        renderSection(doc, null, value, depth + 1);
      } else {
        doc.fontSize(10).fillColor('#666').text(`${label}: `, indent, doc.y, { continued: true });
        doc.fillColor('#333').text(String(value ?? '-'));
        doc.moveDown(0.2);
      }
    }
  }
}

function formatCPF(cpf) {
  const clean = cpf.replace(/[^0-9]/g, '');
  if (clean.length !== 11) return cpf;
  return `${clean.slice(0, 3)}.${clean.slice(3, 6)}.${clean.slice(6, 9)}-${clean.slice(9)}`;
}
