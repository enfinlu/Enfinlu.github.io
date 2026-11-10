#!/usr/bin/env python3
"""Enfin lu · référencement (lot V3a, 10 nov. 2026).

À LANCER À CHAQUE NOUVELLE VERSION DU SITE, juste après le script de fabrication
(build_site_vNNN.py) et avant les tests :

    python3 outils/seo.py index.html

Le script est sans effet s'il a déjà été passé (on peut le relancer sans risque).
Il ne change rien à ce que voit le lecteur. Il pose dans la page d'accueil :
  1. <html lang="fr"> ;
  2. dans l'en-tête : titre, description, adresse canonique, balises de partage
     (og:, twitter:), données structurées (site, organisation, appli) ;
  3. un seul <title> (celui de l'artefact, « Enfin lu », placé dans le corps, est retiré) ;
  4. le programme lit document.title pour ses messages (« Devine ce que j'ai appris sur
     Enfin lu… », « progression d'Enfin lu ») : un petit script de l'en-tête fait que
     document.title rende « Enfin lu » (ce qui précède « · »), alors que la balise <title>,
     celle que lisent Google et l'onglet du navigateur, garde le titre long ;
  5. un texte de présentation pour les moteurs de recherche et les lecteurs d'écran
     (masqué à l'écran, comme les textes « sr-only ») ;
  6. les titres statiques des vieux écrans cachés (« Prochain livre à débloquer »…) vidés :
     ces écrans sont toujours masqués par la feuille de style (règle « .v44 » et
     « [data-view=progres]>:not(#musee) »), et l'appli remplit elle-même ce qu'elle affiche.

Les autres fichiers du lot (robots.txt, sitemap.xml, 404.html, partage-1200x630.jpg,
descriptions de confidentialite.html et testeurs.html) ne sont pas touchés par les
scripts de fabrication : ils restent tels quels d'une version à l'autre.
"""
import json
import re
import sys

SITE = 'https://enfinlu.fr/'
TITRE = 'Enfin lu · Les grands classiques en épisodes de 2 minutes'
DESC = ('Les grands classiques comme une série : Bel-Ami, Pot-Bouille, La Guerre des boutons '
        'en épisodes de 2 minutes, et leur époque en chemin. Gratuit pour commencer.')
IMAGE = SITE + 'partage-1200x630.jpg'
IMAGE_ALT = 'Enfin lu, les grands classiques en épisodes de 2 minutes, sur un téléphone'

# Comptes officiels d'Enfin lu (YouTube, TikTok, Instagram, X…), adresses complètes.
# À remplir quand Guillaume les donne : ils aident Google à relier la marque au site.
RESEAUX = ['https://www.youtube.com/@Enfinlu', 'https://x.com/Enfinlu']

DONNEES = {
    '@context': 'https://schema.org',
    '@graph': [
        {
            '@type': 'WebSite', '@id': SITE + '#site', 'url': SITE,
            'name': 'Enfin lu', 'alternateName': ['enfinlu', 'enfinlu.fr'],
            'inLanguage': 'fr', 'publisher': {'@id': SITE + '#organisation'},
        },
        {
            '@type': 'Organization', '@id': SITE + '#organisation', 'url': SITE,
            'name': 'Enfin lu', 'alternateName': 'enfinlu',
            'logo': SITE + 'icone-512.png', 'email': 'contact@enfinlu.fr',
        },
        {
            '@type': 'WebApplication', '@id': SITE + '#appli', 'url': SITE,
            'name': 'Enfin lu', 'alternateName': 'enfinlu',
            'description': DESC, 'inLanguage': 'fr',
            'applicationCategory': 'EducationalApplication',
            'operatingSystem': 'Android, iOS, Windows, macOS (dans le navigateur)',
            'browserRequirements': 'Un navigateur récent',
            'image': IMAGE,
            'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'EUR'},
            'publisher': {'@id': SITE + '#organisation'},
        },
    ],
}

PRESENTATION = '''<section id="apropos3a" class="v3a" aria-labelledby="v3aT">
<h1 id="v3aT">Enfin lu : les grands classiques en épisodes de 2 minutes</h1>
<p>Enfin lu est une appli de lecture, gratuite pour commencer : on lit les grands romans comme une série, un épisode de deux minutes à la fois, sur téléphone ou sur ordinateur.</p>
<p>Trois romans en entier : <i>Bel-Ami</i> de Guy de Maupassant (1885), <i>Pot-Bouille</i> d'Émile Zola (1882) et <i>La Guerre des boutons</i> de Louis Pergaud (1912). En chemin, on découvre leur époque : les mots d'autrefois, les lieux, les prix, les personnages, et un petit quiz à la fin de l'épisode.</p>
<p>On peut aussi écouter le texte, et continuer à lire sans réseau une fois le livre sur l'appareil.</p>
<ul><li><a href="testeurs">Tester l'appli sur Android avant sa sortie sur Google Play</a></li><li><a href="confidentialite.html">Politique de confidentialité</a></li></ul>
</section>'''

# document.title rend « Enfin lu » pour le programme ; la balise <title> garde le titre long
TITRE_COURT = ('<script>(function(){try{var d=Object.getOwnPropertyDescriptor(Document.prototype,"title");'
               'Object.defineProperty(document,"title",{configurable:true,'
               'get:function(){return String(d.get.call(document)).split(" · ")[0]},'
               'set:function(v){d.set.call(document,v)}})}catch(e){}})()</script>')

CSS = ('<style>.v3a{position:absolute!important;width:1px!important;height:1px!important;margin:-1px!important;'
       'padding:0!important;border:0!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;'
       'clip-path:inset(50%)!important;white-space:nowrap!important}</style>')

# vieux écrans toujours masqués : leurs titres statiques sont vidés (les éléments restent)
VIDES = [
    ('<h1 class="hello" id="hello">Bonsoir</h1>', '<h1 class="hello" id="hello"></h1>'),
    ('<span class="tile-lab">Objectif du jour</span>', '<span class="tile-lab"></span>'),
    ('<h2>Prochain livre à débloquer</h2>', '<h2></h2>'),
    ('<h2>Ta bibliothèque</h2><button type="button" data-goview="biblio">Tout voir</button>',
     '<h2></h2><button type="button" data-goview="biblio"></button>'),
    ('<h2>À débloquer avec tes points</h2>', '<h2></h2>'),
    ('<h1 class="view-title">Progrès</h1>', '<h1 class="view-title"></h1>'),
    ('<p class="tile-lab">Objectif du jour</p>', '<p class="tile-lab"></p>'),
    ('<div class="row-h"><h2>Défis de fin de chapitre</h2></div>\n          <ul class="defis-list" id="pDefiList">',
     '<div class="row-h"><h2></h2></div>\n          <ul class="defis-list" id="pDefiList">'),
    ('<h2>Statistiques</h2></div>\n          <div class="statgrid"', '<h2></h2></div>\n          <div class="statgrid"'),
    ('<h2>Niveaux</h2>', '<h2></h2>'),
]


def esc(s):
    return s.replace('&', '&amp;').replace('"', '&quot;').replace('<', '&lt;')


def entete():
    t = [
        '<!--v3a-->',
        f'<title>{esc(TITRE)}</title>',
        f'<meta name="description" content="{esc(DESC)}">',
        f'<link rel="canonical" href="{SITE}">',
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="Enfin lu">',
        '<meta property="og:locale" content="fr_FR">',
        f'<meta property="og:title" content="{esc(TITRE)}">',
        f'<meta property="og:description" content="{esc(DESC)}">',
        f'<meta property="og:url" content="{SITE}">',
        f'<meta property="og:image" content="{IMAGE}">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        f'<meta property="og:image:alt" content="{esc(IMAGE_ALT)}">',
        '<meta name="twitter:card" content="summary_large_image">',
        f'<meta name="twitter:title" content="{esc(TITRE)}">',
        f'<meta name="twitter:description" content="{esc(DESC)}">',
        f'<meta name="twitter:image" content="{IMAGE}">',
    ]
    d = json.loads(json.dumps(DONNEES))
    if RESEAUX:
        d['@graph'][1]['sameAs'] = RESEAUX
    t.append('<script type="application/ld+json">' + json.dumps(d, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/') + '</script>')
    t.append(TITRE_COURT)
    t.append(CSS)
    t.append('<!--/v3a-->')
    return ''.join(t)


def appliquer(s):
    # 1. langue
    s = re.sub(r'<html(?![^>]*\blang=)', '<html lang="fr"', s, count=1)
    # 2. en-tête (remplacé s'il existe déjà : le texte peut avoir changé)
    s = re.sub(r'<!--v3a-->.*?<!--/v3a-->', '', s, flags=re.S)
    fin = s.find('</head>')
    if fin < 0:
        raise SystemExit('pas de </head> dans la page')
    s = s[:fin] + entete() + s[fin:]
    # 3. un seul <title> : ceux qui sont après </head> sont retirés
    fin = s.find('</head>')
    s = s[:fin] + re.sub(r'\n?<title>[^<]*</title>', '', s[fin:])
    # 4. (première version du lot : scripts autour du programme, retirés s'ils sont là)
    s = s.replace('<script>window.__t3a=document.title;document.title="Enfin lu"</script>', '')
    s = s.replace('<script>document.title=window.__t3a</script>', '')
    # 5. texte de présentation, juste avant le programme
    s = re.sub(r'<section id="apropos3a".*?</section>\n?', '', s, flags=re.S)
    m = re.search(r'<script src="app-[0-9a-f]+\.js"></script>', s)
    if not m:
        raise SystemExit('programme app-*.js introuvable')
    s = s[:m.start()] + PRESENTATION + '\n' + s[m.start():]
    # 6. vieux écrans
    for a, b in VIDES:
        s = s.replace(a, b)
    s = re.sub(r'<p class="credits">1 mot lu = 1 point[^<]*</p>', '<p class="credits"></p>', s)
    return s


def verifier(s):
    fin = s.find('</head>')
    tete = s[:fin]
    ok = {
        'lang fr': bool(re.match(r'<!doctype html><html lang="fr"', s, re.I)),
        'un seul title': s.count('<title>') == 1 and '<title>' in tete,
        'description': 'name="description"' in tete,
        'canonique': f'rel="canonical" href="{SITE}"' in tete,
        'og:image': 'og:image' in tete,
        'données structurées': 'application/ld+json' in tete,
        'présentation': 'id="apropos3a"' in s,
        'titre court pour le programme': 'Document.prototype,"title"' in tete and 'window.__t3a' not in s,
        'vieux titres vidés': not any(x in s for x in ['Prochain livre à débloquer', 'À débloquer avec tes points', '<h2>Niveaux</h2>']),
    }
    return ok


if __name__ == '__main__':
    f = sys.argv[1] if len(sys.argv) > 1 else 'index.html'
    s = open(f, encoding='utf-8').read()
    s2 = appliquer(s)
    open(f, 'w', encoding='utf-8').write(s2)
    res = verifier(s2)
    for k, v in res.items():
        print(('OK   ' if v else 'MANQUE ') + k)
    if not all(res.values()):
        sys.exit(1)
