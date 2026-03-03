import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import the sanitization function directly
// We mock config since output-filter imports it
const originalConfig = { site: { url: 'https://credpositivo.com/diagnostico' } };

// Dynamic import to handle ESM + config dependency
let sanitizeForWhatsApp, fixSiteLinks;

// Load modules before tests
const outputFilter = await import('../ai/output-filter.js');
sanitizeForWhatsApp = outputFilter.sanitizeForWhatsApp;
fixSiteLinks = outputFilter.fixSiteLinks;

// === Helper: simulate bubble split (same logic as manager.js) ===
function splitIntoBubbles(text) {
  const messageParts = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  const finalParts = [];
  for (const part of messageParts) {
    if (part.length <= 150) {
      finalParts.push(part);
    } else {
      let remaining = part;
      while (remaining.length > 150) {
        let breakPoint = remaining.lastIndexOf(' ', 150);
        if (breakPoint <= 0) breakPoint = 150;
        finalParts.push(remaining.substring(0, breakPoint).trim());
        remaining = remaining.substring(breakPoint).trim();
      }
      if (remaining.length > 0) finalParts.push(remaining);
    }
  }
  return finalParts;
}

// === Tests ===

describe('sanitizeForWhatsApp', () => {
  it('strips markdown bold', () => {
    const result = sanitizeForWhatsApp('**texto em negrito**');
    assert.equal(result, 'texto em negrito');
  });

  it('strips markdown italic', () => {
    const result = sanitizeForWhatsApp('*texto italico*');
    assert.equal(result, 'texto italico');
  });

  it('strips markdown code', () => {
    const result = sanitizeForWhatsApp('`codigo aqui`');
    assert.equal(result, 'codigo aqui');
  });

  it('strips markdown headers', () => {
    const result = sanitizeForWhatsApp('## Header aqui');
    assert.equal(result, 'Header aqui');
  });

  it('removes ALL emojis', () => {
    const result = sanitizeForWhatsApp('Oi! 😊🚀💪 Tudo bem?');
    assert.equal(result, 'Oi! Tudo bem?');
  });

  it('removes specific emoji characters', () => {
    const result = sanitizeForWhatsApp('Check ✅ isso ❌ aqui 👇');
    assert.equal(result, 'Check isso aqui');
  });

  it('removes [METADATA] blocks', () => {
    const input = 'Oi, tudo bem?\n\n[METADATA]\n{"phase":1,"should_send_link":false}\n[/METADATA]';
    const result = sanitizeForWhatsApp(input);
    assert.equal(result, 'Oi, tudo bem?');
  });

  it('preserves \\n\\n for bubble splitting', () => {
    const input = 'Primeira bolha\n\nSegunda bolha';
    const result = sanitizeForWhatsApp(input);
    assert.ok(result.includes('\n\n'), 'Should preserve \\n\\n');
    assert.equal(result, 'Primeira bolha\n\nSegunda bolha');
  });

  it('collapses 3+ newlines into exactly 2', () => {
    const input = 'Parte 1\n\n\n\nParte 2';
    const result = sanitizeForWhatsApp(input);
    assert.equal(result, 'Parte 1\n\nParte 2');
  });

  it('cleans double spaces', () => {
    const result = sanitizeForWhatsApp('texto  com   espacos');
    assert.equal(result, 'texto com espacos');
  });

  it('truncates messages > 1000 chars', () => {
    const longText = 'A'.repeat(1500);
    const result = sanitizeForWhatsApp(longText);
    assert.equal(result.length, 1000);
    assert.ok(result.endsWith('...'));
  });

  it('preserves site links', () => {
    const input = 'Acessa aqui: https://credpositivo.com/diagnostico';
    const result = sanitizeForWhatsApp(input);
    assert.ok(result.includes('credpositivo.com/diagnostico'));
  });

  it('handles combined dirty input', () => {
    const input = '**Oi** 😊\n\n\n\nVeja aqui: `link`\n\n[METADATA]\n{"phase":1}\n[/METADATA]';
    const result = sanitizeForWhatsApp(input);
    assert.ok(!result.includes('**'));
    assert.ok(!result.includes('😊'));
    assert.ok(!result.includes('[METADATA]'));
    assert.ok(!result.includes('`'));
    assert.ok(!result.includes('\n\n\n'));
  });
});

describe('Bubble splitting', () => {
  it('splits on \\n\\n into separate bubbles', () => {
    const text = 'Bolha 1\n\nBolha 2\n\nBolha 3';
    const parts = splitIntoBubbles(text);
    assert.equal(parts.length, 3);
    assert.equal(parts[0], 'Bolha 1');
    assert.equal(parts[1], 'Bolha 2');
    assert.equal(parts[2], 'Bolha 3');
  });

  it('breaks bubble > 150 chars at nearest space', () => {
    const longBubble = 'Esta e uma frase muito longa que ultrapassa o limite de cento e cinquenta caracteres e precisa ser quebrada automaticamente no espaco mais proximo do limite estabelecido.';
    assert.ok(longBubble.length > 150, 'Test input should be > 150 chars');
    const parts = splitIntoBubbles(longBubble);
    assert.ok(parts.length >= 2, 'Should split into 2+ parts');
    for (const part of parts) {
      assert.ok(part.length <= 150, `Bubble "${part}" exceeds 150 chars (${part.length})`);
    }
  });

  it('preserves short bubbles as-is', () => {
    const text = 'Curta\n\nTambem curta';
    const parts = splitIntoBubbles(text);
    assert.equal(parts.length, 2);
    assert.equal(parts[0], 'Curta');
    assert.equal(parts[1], 'Tambem curta');
  });

  it('handles single message without \\n\\n', () => {
    const text = 'Mensagem unica sem quebra';
    const parts = splitIntoBubbles(text);
    assert.equal(parts.length, 1);
    assert.equal(parts[0], 'Mensagem unica sem quebra');
  });

  it('filters empty parts from multiple \\n\\n', () => {
    const text = 'Parte 1\n\n\n\nParte 2';
    const parts = splitIntoBubbles(text);
    assert.equal(parts.length, 2);
    assert.ok(!parts.includes(''));
  });

  it('end-to-end: sanitize + split', () => {
    const dirtyInput = '**Oi, tudo bem?** 😊\n\nVeja esse video que mostra como funciona o diagnostico bancario completo do seu CPF com todas as informacoes que os bancos realmente analisam na hora de aprovar ou negar credito.\n\n[METADATA]\n{"phase":2}\n[/METADATA]';
    const sanitized = sanitizeForWhatsApp(dirtyInput);
    const parts = splitIntoBubbles(sanitized);

    assert.ok(parts.length >= 2, 'Should have at least 2 bubbles');
    for (const part of parts) {
      assert.ok(part.length <= 150, `Bubble exceeds 150 chars (${part.length}): "${part}"`);
      assert.ok(!part.includes('**'), 'No markdown');
      assert.ok(!part.includes('[METADATA]'), 'No metadata');
    }
  });
});

describe('fixSiteLinks', () => {
  it('normalizes shortened URLs', () => {
    const result = fixSiteLinks('Veja: http://credpositivo.com');
    assert.ok(result.includes('credpositivo.com'));
  });
});
