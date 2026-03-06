#!/usr/bin/env python3
"""
Brand Voice Analyzer — Analisa conteudo para consistencia de voz da marca CredPositivo
"""

import re
from typing import Dict, List
import json

class BrandVoiceAnalyzer:
    def __init__(self):
        self.voice_dimensions = {
            'formalidade': {
                'formal': ['portanto', 'todavia', 'ademais', 'mediante', 'conforme', 'referente'],
                'informal': ['tipo', 'massa', 'show', 'bora', 'top', 'dale']
            },
            'tom': {
                'profissional': ['solucao', 'otimizar', 'estrategico', 'resultado', 'expertise'],
                'acessivel': ['simples', 'facil', 'rapidinho', 'descomplicado', 'direto']
            },
            'perspectiva': {
                'autoritativo': ['comprovado', 'pesquisas mostram', 'dados indicam', 'garantido por lei'],
                'conversacional': ['voce pode', 'vamos ver', 'a gente', 'imagina so', 'olha so']
            },
            'emocao': {
                'empoderador': ['direito', 'conquista', 'liberdade', 'poder', 'transformacao', 'aprovado'],
                'medo': ['perigo', 'cuidado', 'urgente', 'nunca', 'pior', 'risco']
            }
        }

        # Palavras-chave CredPositivo
        self.brand_keywords = [
            'credito', 'score', 'spc', 'serasa', 'nome limpo', 'negativado',
            'diagnostico', 'rating', 'bancario', 'limpa nome', 'credpositivo',
            'financeiro', 'divida', 'cartao', 'emprestimo', 'financiamento'
        ]

    def analyze_text(self, text: str) -> Dict:
        """Analisa texto para caracteristicas de voz da marca"""
        text_lower = text.lower()
        word_count = len(text.split())

        results = {
            'contagem_palavras': word_count,
            'legibilidade': self._calculate_readability(text),
            'perfil_voz': {},
            'analise_frases': self._analyze_sentences(text),
            'keywords_marca': self._check_brand_keywords(text_lower),
            'compliance': self._check_compliance(text_lower),
            'recomendacoes': []
        }

        # Analisar dimensoes de voz
        for dimension, categories in self.voice_dimensions.items():
            dim_scores = {}
            for category, keywords in categories.items():
                score = sum(1 for keyword in keywords if keyword in text_lower)
                dim_scores[category] = score

            if sum(dim_scores.values()) > 0:
                dominant = max(dim_scores, key=dim_scores.get)
                results['perfil_voz'][dimension] = {
                    'dominante': dominant,
                    'scores': dim_scores
                }

        results['recomendacoes'] = self._generate_recommendations(results)
        return results

    def _calculate_readability(self, text: str) -> float:
        """Calcula score de legibilidade"""
        sentences = re.split(r'[.!?]+', text)
        words = text.split()
        syllables = sum(self._count_syllables(word) for word in words)

        if len(sentences) == 0 or len(words) == 0:
            return 0

        avg_sentence_length = len(words) / len(sentences)
        avg_syllables_per_word = syllables / len(words)

        score = 206.835 - 1.015 * avg_sentence_length - 84.6 * avg_syllables_per_word
        return max(0, min(100, score))

    def _count_syllables(self, word: str) -> int:
        """Conta silabas (simplificado para portugues)"""
        word = word.lower()
        vowels = 'aeiouáéíóúâêîôûãõ'
        syllable_count = 0
        previous_was_vowel = False

        for char in word:
            is_vowel = char in vowels
            if is_vowel and not previous_was_vowel:
                syllable_count += 1
            previous_was_vowel = is_vowel

        return max(1, syllable_count)

    def _analyze_sentences(self, text: str) -> Dict:
        """Analisa estrutura das frases"""
        sentences = re.split(r'[.!?]+', text)
        sentences = [s.strip() for s in sentences if s.strip()]

        if not sentences:
            return {'comprimento_medio': 0, 'variedade': 'baixa', 'total': 0}

        lengths = [len(s.split()) for s in sentences]
        avg_length = sum(lengths) / len(lengths) if lengths else 0

        if len(set(lengths)) < 3:
            variety = 'baixa'
        elif len(set(lengths)) < 5:
            variety = 'media'
        else:
            variety = 'alta'

        return {
            'comprimento_medio': round(avg_length, 1),
            'variedade': variety,
            'total': len(sentences)
        }

    def _check_brand_keywords(self, text_lower: str) -> Dict:
        """Verifica uso de palavras-chave da marca"""
        found = {}
        for keyword in self.brand_keywords:
            count = text_lower.count(keyword)
            if count > 0:
                found[keyword] = count
        return {
            'encontradas': found,
            'total': sum(found.values()),
            'cobertura': f"{len(found)}/{len(self.brand_keywords)}"
        }

    def _check_compliance(self, text_lower: str) -> Dict:
        """Verifica compliance do conteudo"""
        issues = []

        # Palavras proibidas
        forbidden = ['garantimos', '100%', 'milagre', 'impossivel', 'unico']
        for word in forbidden:
            if word in text_lower:
                issues.append(f"Palavra proibida encontrada: '{word}'")

        # Verificar se menciona preco do Rating proativamente
        if 'r$997' in text_lower or '997' in text_lower:
            issues.append("Preco do Rating (R$997) nao deve ser mencionado proativamente")

        # Verificar alarmismo
        alarm_words = ['perigo', 'urgente', 'cuidado', 'nunca mais']
        alarm_count = sum(1 for w in alarm_words if w in text_lower)
        if alarm_count >= 2:
            issues.append("Tom pode estar muito alarmista — prefira empoderamento")

        return {
            'ok': len(issues) == 0,
            'problemas': issues
        }

    def _generate_recommendations(self, analysis: Dict) -> List[str]:
        """Gera recomendacoes baseadas na analise"""
        recommendations = []

        # Legibilidade
        if analysis['legibilidade'] < 30:
            recommendations.append("Simplifique a linguagem — o publico CredPositivo precisa de textos acessiveis")
        elif analysis['legibilidade'] > 80:
            recommendations.append("Texto muito simples — adicione mais autoridade e dados")

        # Variedade de frases
        if analysis['analise_frases']['variedade'] == 'baixa':
            recommendations.append("Varie o tamanho das frases para melhor ritmo de leitura")

        # Keywords da marca
        if analysis['keywords_marca']['total'] == 0:
            recommendations.append("Inclua palavras-chave da marca (credito, score, SPC, nome limpo)")

        # Compliance
        if not analysis['compliance']['ok']:
            for issue in analysis['compliance']['problemas']:
                recommendations.append(f"COMPLIANCE: {issue}")

        # Voz
        if 'emocao' in analysis['perfil_voz']:
            if analysis['perfil_voz']['emocao']['dominante'] == 'medo':
                recommendations.append("Tom de medo detectado — prefira empoderamento (ex: 'voce TEM direito')")

        return recommendations

def analyze_content(content: str, output_format: str = 'json') -> str:
    """Funcao principal"""
    analyzer = BrandVoiceAnalyzer()
    results = analyzer.analyze_text(content)

    if output_format == 'json':
        return json.dumps(results, indent=2, ensure_ascii=False)
    else:
        output = [
            "=== Analise de Voz da Marca — CredPositivo ===",
            f"Palavras: {results['contagem_palavras']}",
            f"Legibilidade: {results['legibilidade']:.1f}/100",
            "",
            "Perfil de Voz:"
        ]

        for dimension, profile in results['perfil_voz'].items():
            output.append(f"  {dimension.title()}: {profile['dominante']}")

        output.extend([
            "",
            "Analise de Frases:",
            f"  Comprimento medio: {results['analise_frases']['comprimento_medio']} palavras",
            f"  Variedade: {results['analise_frases']['variedade']}",
            f"  Total: {results['analise_frases']['total']}",
            "",
            f"Keywords da Marca: {results['keywords_marca']['cobertura']} encontradas",
            f"Compliance: {'OK' if results['compliance']['ok'] else 'PROBLEMAS ENCONTRADOS'}",
            "",
            "Recomendacoes:"
        ])

        for rec in results['recomendacoes']:
            output.append(f"  • {rec}")

        return '\n'.join(output)

if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r') as f:
            content = f.read()

        output_format = sys.argv[2] if len(sys.argv) > 2 else 'text'
        print(analyze_content(content, output_format))
    else:
        print("Uso: python brand_voice_analyzer.py <arquivo> [json|text]")
