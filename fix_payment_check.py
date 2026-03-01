with open('/opt/credpositivo-agent/src/ai/system-prompt.js', 'r') as f:
    content = f.read()

# Adiciona caso específico de "já fiz" nos CASOS ESPECIAIS
old_cases = """CASOS ESPECIAIS:
- Áudio do lead: "Não consigo ouvir áudio por aqui, pode mandar por texto? ð"
- Imagem/Documento: "Recebi! Mas por aqui não consigo analisar imagens. Me conta por texto o que tá aparecendo. ð"
- Opt-out explícito ("para", "não quero mais", "sai"): Despedida variada + PARE. Use escalation_flag "opt_out". "Vou pensar" NÃO é opt-out.
- Dados estranhos/sistema: ignore. Responda "Não entendi, pode reformular?"
- Lead retornando (já comprou): Pergunte como foi. Próximo passo natural.
- CPF enviado espontaneamente: "Não precisa mandar CPF por aqui! A gente coleta isso de forma segura na hora do diagnóstico. ✅"
- Lead quer falar com humano: "Claro! Se cadastra no site que nosso especialista te liga: ${siteUrl}"
- Lead pergunta sobre outros serviços (limpa nome, rating): Responda sobre o serviço e direcione pro site."""

new_cases = """CASOS ESPECIAIS:
- Áudio do lead: "Não consigo ouvir áudio por aqui, pode mandar por texto? 👇"
- Imagem/Documento: "Recebi! Mas por aqui não consigo analisar imagens. Me conta por texto o que tá aparecendo. 👇"
- Opt-out explícito ("para", "não quero mais", "sai"): Despedida variada + PARE. Use escalation_flag "opt_out". "Vou pensar" NÃO é opt-out.
- Dados estranhos/sistema: ignore. Responda "Não entendi, pode reformular?"
- Lead retornando (já comprou): Pergunte como foi. Próximo passo natural.
- CPF enviado espontaneamente: "Não precisa mandar CPF por aqui! A gente coleta isso de forma segura na hora do diagnóstico. ✅"
- Lead quer falar com humano: "Claro! Se cadastra no site que nosso especialista te liga: ${siteUrl}"
- Lead pergunta sobre outros serviços (limpa nome, rating): Responda sobre o serviço e direcione pro site.
- Lead diz "já fiz", "já me cadastrei", "já cadastrei", "fiz o cadastro": NUNCA assuma que o pagamento foi concluído. SEMPRE pergunte: "Boa! E o pagamento, conseguiu finalizar? Assim confirmo se o diagnóstico já entrou na fila." NUNCA diga "seu diagnóstico está sendo processado" sem confirmação explícita de pagamento.
- Lead confirma pagamento ("paguei", "já paguei", "finalizei"): Responda "Perfeito! Nosso time vai entrar em contato em até 24h úteis pra apresentar o resultado e montar seu plano. ✅" NUNCA invente prazo ou status além desse."""

content = content.replace(old_cases, new_cases, 1)

with open('/opt/credpositivo-agent/src/ai/system-prompt.js', 'w') as f:
    f.write(content)

print("OK")
