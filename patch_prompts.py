import re

# ─── PATCH 1: system-prompt.js (Augusto) ───────────────────────────────────
with open('/opt/credpositivo-agent/src/ai/system-prompt.js', 'r') as f:
    content = f.read()

# Guardrail 1: Link só na fase 3+
old_link = "LINK: O ÚNICO link permitido é exatamente ${siteUrl} — copie EXATAMENTE como está."
new_link = ("REGRA DE LINK — FASES BLOQUEADAS: NUNCA envie o link ${siteUrl} nas fases 0, 1 ou 2. "
            "O link só pode ser enviado a partir da fase 3. "
            "Nas fases 0-2, should_send_link deve ser SEMPRE false. "
            "Violar essa regra queima o lead.\n\n"
            "LINK: O ÚNICO link permitido é exatamente ${siteUrl} — copie EXATAMENTE como está.")
content = content.replace(old_link, new_link, 1)

# Guardrail 2: Nunca inventar status
old_proibido = "PROIBIDO: prometer aprovação/score, pedir CPF/dados bancários, inventar dados, pressionar compra, criar urgência falsa, mencionar termos técnicos (Bacen, SCR, thin file, perfil fino, perfil bancário, API, webhook, código)."
new_proibido = ("PROIBIDO: prometer aprovação/score, pedir CPF/dados bancários, inventar dados, pressionar compra, "
                "criar urgência falsa, mencionar termos técnicos (Bacen, SCR, thin file, perfil fino, perfil bancário, API, webhook, código), "
                "inventar status de pedido/diagnóstico/ordem (se perguntarem: 'Nosso time vai confirmar por aqui em até 24h úteis.').")
content = content.replace(old_proibido, new_proibido, 1)

with open('/opt/credpositivo-agent/src/ai/system-prompt.js', 'w') as f:
    f.write(content)

print("system-prompt.js patched OK")

# ─── PATCH 2: sdr-prompt.js (Paulo) ────────────────────────────────────────
with open('/opt/credpositivo-agent/src/ai/sdr-prompt.js', 'r') as f:
    content = f.read()

# Guardrail 3: Não repetir CTA após "não"
old_rule10 = "10. Depois de informar preço, SEMPRE envie o link."
new_rule10 = ("10. Depois de informar preço, SEMPRE envie o link.\n"
              "11. Se o lead já recebeu o link E disse que não tem interesse, PARE. "
              "Não repita o mesmo CTA. Encerre com: 'Combinado! Se mudar de ideia, é só chamar.' NUNCA insista depois disso.\n"
              "12. NUNCA invente status de pedido, diagnóstico ou contrato. "
              "Se perguntarem: 'Nosso time vai confirmar por aqui em até 24h úteis.'")
content = content.replace(old_rule10, new_rule10, 1)

# Guardrail 4: Paulo sem contexto do Augusto = BLOQUEIO
old_transfer = "const isTransferFromAugusto = !!recommended_product && Object.keys(user_profile).length > 0;"
new_transfer = ("const isTransferFromAugusto = !!recommended_product && Object.keys(user_profile).length > 0;\n"
                "  // REGRA: Paulo NUNCA começa do zero. Se veio do Augusto, usa o contexto. Se não tem contexto, pede pro lead explicar a situação rapidamente.")
content = content.replace(old_transfer, new_transfer, 1)

with open('/opt/credpositivo-agent/src/ai/sdr-prompt.js', 'w') as f:
    f.write(content)

print("sdr-prompt.js patched OK")
