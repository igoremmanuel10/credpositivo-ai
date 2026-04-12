const NIVEL_TEXT = {
  critico: 'Crítico — sua situação precisa de atenção urgente',
  atencao: 'Atenção — tem solução, mas precisa de um plano certo',
  preventivo: 'Preventivo — você está num bom caminho',
};

export function buildDispatchMessage(lead) {
  const firstName = (lead.nome || '').trim().split(/\s+/)[0] || 'tudo bem';
  const nivelMsg = NIVEL_TEXT[lead.nivel] || 'seu diagnóstico de crédito';

  return (
    `Oi ${firstName}, tudo bem? Aqui é o Igor da CredPositivo.\n\n` +
    `Vi que você fez nosso diagnóstico de crédito e seu resultado foi: ${nivelMsg}.\n\n` +
    `Queria entender melhor sua situação e ver como a gente pode te ajudar a destravar seu crédito. Tem 2 minutinhos?`
  );
}

const OPTOUT_RE = /\b(pare|sair|remove|remover|cancelar|descadastr|n[ãa]o me mand|n[ãa]o quero|parar)\b/i;

export function isOptOut(text) {
  if (!text) return false;
  return OPTOUT_RE.test(text);
}
