#!/usr/bin/env python3
"""
SEO Content Optimizer — Analisa e otimiza conteudo para SEO (CredPositivo)
"""

import re
from typing import Dict, List
import json

class SEOOptimizer:
    def __init__(self):
        # Stop words em portugues
        self.stop_words = {
            'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da',
            'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'com',
            'sem', 'sob', 'sobre', 'entre', 'que', 'se', 'ao', 'aos', 'pelo',
            'pela', 'pelos', 'pelas', 'e', 'ou', 'mas', 'como', 'mais', 'muito',
            'ja', 'seu', 'sua', 'seus', 'suas', 'esse', 'essa', 'este', 'esta',
            'isso', 'isto', 'aquele', 'aquela', 'ele', 'ela', 'eles', 'elas',
            'nos', 'voce', 'voces', 'meu', 'minha', 'ser', 'estar', 'ter', 'fazer',
            'pode', 'vai', 'foi', 'tem', 'sao', 'esta', 'nao', 'sim'
        }

        self.best_practices = {
            'title_length': (50, 60),
            'meta_description_length': (150, 160),
            'url_length': (50, 60),
            'paragraph_length': (40, 150),
            'keyword_density': (0.01, 0.03)
        }

    def analyze(self, content: str, target_keyword: str = None,
                secondary_keywords: List[str] = None) -> Dict:
        """Analisa conteudo para otimizacao SEO"""
        analysis = {
            'contagem_palavras': len(content.split()),
            'keyword_analysis': {},
            'estrutura': self._analyze_structure(content),
            'legibilidade': self._analyze_readability(content),
            'meta_sugestoes': {},
            'score_seo': 0,
            'recomendacoes': []
        }

        if target_keyword:
            analysis['keyword_analysis'] = self._analyze_keywords(
                content, target_keyword, secondary_keywords or []
            )

        analysis['meta_sugestoes'] = self._generate_meta_suggestions(
            content, target_keyword
        )

        analysis['score_seo'] = self._calculate_seo_score(analysis)
        analysis['recomendacoes'] = self._generate_recommendations(analysis)

        return analysis

    def _analyze_keywords(self, content: str, primary: str,
                         secondary: List[str]) -> Dict:
        """Analisa uso e densidade de palavras-chave"""
        content_lower = content.lower()
        word_count = len(content.split())

        results = {
            'keyword_principal': {
                'keyword': primary,
                'contagem': content_lower.count(primary.lower()),
                'densidade': 0,
                'no_titulo': False,
                'nos_headings': False,
                'no_primeiro_paragrafo': False
            },
            'keywords_secundarias': [],
            'keywords_lsi': []
        }

        if word_count > 0:
            results['keyword_principal']['densidade'] = (
                results['keyword_principal']['contagem'] / word_count
            )

        first_para = content.split('\n\n')[0] if '\n\n' in content else content[:200]
        results['keyword_principal']['no_primeiro_paragrafo'] = (
            primary.lower() in first_para.lower()
        )

        for keyword in secondary:
            count = content_lower.count(keyword.lower())
            results['keywords_secundarias'].append({
                'keyword': keyword,
                'contagem': count,
                'densidade': count / word_count if word_count > 0 else 0
            })

        results['keywords_lsi'] = self._extract_lsi_keywords(content, primary)
        return results

    def _analyze_structure(self, content: str) -> Dict:
        """Analisa estrutura do conteudo"""
        lines = content.split('\n')

        structure = {
            'headings': {'h1': 0, 'h2': 0, 'h3': 0, 'total': 0},
            'paragrafos': 0,
            'listas': 0,
            'links': {'internos': 0, 'externos': 0},
            'comprimento_medio_paragrafo': 0
        }

        paragraphs = []
        current_para = []

        for line in lines:
            if line.startswith('# '):
                structure['headings']['h1'] += 1
                structure['headings']['total'] += 1
            elif line.startswith('## '):
                structure['headings']['h2'] += 1
                structure['headings']['total'] += 1
            elif line.startswith('### '):
                structure['headings']['h3'] += 1
                structure['headings']['total'] += 1

            if line.strip().startswith(('- ', '* ', '1. ')):
                structure['listas'] += 1

            internal_links = len(re.findall(r'\[.*?\]\(/.*?\)', line))
            external_links = len(re.findall(r'\[.*?\]\(https?://.*?\)', line))
            structure['links']['internos'] += internal_links
            structure['links']['externos'] += external_links

            if line.strip() and not line.startswith('#'):
                current_para.append(line)
            elif current_para:
                paragraphs.append(' '.join(current_para))
                current_para = []

        if current_para:
            paragraphs.append(' '.join(current_para))

        structure['paragrafos'] = len(paragraphs)

        if paragraphs:
            avg_length = sum(len(p.split()) for p in paragraphs) / len(paragraphs)
            structure['comprimento_medio_paragrafo'] = round(avg_length, 1)

        return structure

    def _analyze_readability(self, content: str) -> Dict:
        """Analisa legibilidade"""
        sentences = re.split(r'[.!?]+', content)
        words = content.split()

        if not sentences or not words:
            return {'score': 0, 'nivel': 'Desconhecido'}

        avg_sentence_length = len(words) / len(sentences)

        if avg_sentence_length < 15:
            level = 'Facil'
            score = 90
        elif avg_sentence_length < 20:
            level = 'Moderado'
            score = 70
        elif avg_sentence_length < 25:
            level = 'Dificil'
            score = 50
        else:
            level = 'Muito Dificil'
            score = 30

        return {
            'score': score,
            'nivel': level,
            'comprimento_medio_frase': round(avg_sentence_length, 1)
        }

    def _extract_lsi_keywords(self, content: str, primary_keyword: str) -> List[str]:
        """Extrai keywords LSI (semanticamente relacionadas)"""
        words = re.findall(r'\b[a-záéíóúâêîôûãõç]+\b', content.lower())
        word_freq = {}

        for word in words:
            if word not in self.stop_words and len(word) > 3:
                word_freq[word] = word_freq.get(word, 0) + 1

        sorted_words = sorted(word_freq.items(), key=lambda x: x[1], reverse=True)

        lsi_keywords = []
        for word, count in sorted_words:
            if word != primary_keyword.lower() and count > 1:
                lsi_keywords.append(word)
            if len(lsi_keywords) >= 10:
                break

        return lsi_keywords

    def _generate_meta_suggestions(self, content: str, keyword: str = None) -> Dict:
        """Gera sugestoes de meta tags"""
        sentences = re.split(r'[.!?]+', content)
        first_sentence = sentences[0] if sentences else content[:160]

        suggestions = {
            'titulo': '',
            'meta_descricao': '',
            'url_slug': '',
            'og_titulo': '',
            'og_descricao': ''
        }

        if keyword:
            suggestions['titulo'] = f"{keyword.title()} — Guia Completo | CredPositivo"
            if len(suggestions['titulo']) > 60:
                suggestions['titulo'] = f"{keyword.title()} | CredPositivo"[:60]

            desc_base = f"Saiba tudo sobre {keyword}. {first_sentence}"
            if len(desc_base) > 160:
                desc_base = desc_base[:157] + "..."
            suggestions['meta_descricao'] = desc_base

            suggestions['url_slug'] = re.sub(r'[^a-z0-9-]+', '-',
                                            keyword.lower()).strip('-')

            suggestions['og_titulo'] = suggestions['titulo']
            suggestions['og_descricao'] = suggestions['meta_descricao']

        return suggestions

    def _calculate_seo_score(self, analysis: Dict) -> int:
        """Calcula score SEO geral"""
        score = 0

        # Tamanho do conteudo (20 pts)
        if 300 <= analysis['contagem_palavras'] <= 2500:
            score += 20
        elif 200 <= analysis['contagem_palavras'] < 300:
            score += 10
        elif analysis['contagem_palavras'] > 2500:
            score += 15

        # Keywords (30 pts)
        if analysis['keyword_analysis']:
            kw_data = analysis['keyword_analysis']['keyword_principal']
            if 0.01 <= kw_data['densidade'] <= 0.03:
                score += 15
            elif 0.005 <= kw_data['densidade'] < 0.01:
                score += 8
            if kw_data['no_primeiro_paragrafo']:
                score += 10
            if kw_data.get('nos_headings'):
                score += 5

        # Estrutura (25 pts)
        struct = analysis['estrutura']
        if struct['headings']['total'] > 0:
            score += 10
        if struct['paragrafos'] >= 3:
            score += 10
        if struct['links']['internos'] > 0 or struct['links']['externos'] > 0:
            score += 5

        # Legibilidade (25 pts)
        readability_score = analysis['legibilidade']['score']
        score += int(readability_score * 0.25)

        return min(score, 100)

    def _generate_recommendations(self, analysis: Dict) -> List[str]:
        """Gera recomendacoes de SEO"""
        recommendations = []

        if analysis['contagem_palavras'] < 300:
            recommendations.append(
                f"Aumente o conteudo para pelo menos 300 palavras (atualmente {analysis['contagem_palavras']})"
            )
        elif analysis['contagem_palavras'] > 3000:
            recommendations.append(
                "Considere dividir o conteudo em paginas ou adicionar indice"
            )

        if analysis['keyword_analysis']:
            kw_data = analysis['keyword_analysis']['keyword_principal']
            if kw_data['densidade'] < 0.01:
                recommendations.append(
                    f"Aumente a densidade da keyword '{kw_data['keyword']}' (atualmente {kw_data['densidade']:.2%})"
                )
            elif kw_data['densidade'] > 0.03:
                recommendations.append(
                    f"Reduza a densidade da keyword para evitar over-optimization ({kw_data['densidade']:.2%})"
                )
            if not kw_data['no_primeiro_paragrafo']:
                recommendations.append("Inclua a keyword principal no primeiro paragrafo")

        struct = analysis['estrutura']
        if struct['headings']['total'] == 0:
            recommendations.append("Adicione headings (H1, H2, H3) para melhor estrutura")
        if struct['links']['internos'] == 0:
            recommendations.append("Adicione links internos para conteudo relacionado")
        if struct['comprimento_medio_paragrafo'] > 150:
            recommendations.append("Quebre paragrafos longos para melhor legibilidade")

        if analysis['legibilidade']['comprimento_medio_frase'] > 20:
            recommendations.append("Simplifique as frases para melhor legibilidade")

        return recommendations

def optimize_content(content: str, keyword: str = None,
                     secondary_keywords: List[str] = None) -> str:
    """Funcao principal"""
    optimizer = SEOOptimizer()

    if secondary_keywords and isinstance(secondary_keywords, str):
        secondary_keywords = [kw.strip() for kw in secondary_keywords.split(',')]

    results = optimizer.analyze(content, keyword, secondary_keywords)

    output = [
        "=== Analise SEO — CredPositivo ===",
        f"Score SEO: {results['score_seo']}/100",
        f"Palavras: {results['contagem_palavras']}",
        "",
        "Estrutura:",
        f"  Headings: {results['estrutura']['headings']['total']}",
        f"  Paragrafos: {results['estrutura']['paragrafos']}",
        f"  Comprimento medio paragrafo: {results['estrutura']['comprimento_medio_paragrafo']} palavras",
        f"  Links internos: {results['estrutura']['links']['internos']}",
        f"  Links externos: {results['estrutura']['links']['externos']}",
        "",
        f"Legibilidade: {results['legibilidade']['nivel']} (Score: {results['legibilidade']['score']})",
        ""
    ]

    if results['keyword_analysis']:
        kw = results['keyword_analysis']['keyword_principal']
        output.extend([
            "Keywords:",
            f"  Principal: {kw['keyword']}",
            f"  Contagem: {kw['contagem']}",
            f"  Densidade: {kw['densidade']:.2%}",
            f"  No 1o paragrafo: {'Sim' if kw['no_primeiro_paragrafo'] else 'Nao'}",
            ""
        ])

        if results['keyword_analysis']['keywords_lsi']:
            output.append("  Keywords relacionadas:")
            for lsi in results['keyword_analysis']['keywords_lsi'][:5]:
                output.append(f"    • {lsi}")
            output.append("")

    if results['meta_sugestoes']:
        output.extend([
            "Sugestoes de Meta Tags:",
            f"  Titulo: {results['meta_sugestoes']['titulo']}",
            f"  Descricao: {results['meta_sugestoes']['meta_descricao']}",
            f"  URL Slug: {results['meta_sugestoes']['url_slug']}",
            ""
        ])

    output.append("Recomendacoes:")
    for rec in results['recomendacoes']:
        output.append(f"  • {rec}")

    return '\n'.join(output)

if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1:
        with open(sys.argv[1], 'r') as f:
            content = f.read()

        keyword = sys.argv[2] if len(sys.argv) > 2 else None
        secondary = sys.argv[3] if len(sys.argv) > 3 else None

        print(optimize_content(content, keyword, secondary))
    else:
        print("Uso: python seo_optimizer.py <arquivo> [keyword_principal] [keywords_secundarias]")
