# Banc d'essai : 48 cartes (graine 3)

| | Scan propre | Photo simulée |
|---|---|---|
| Cartes testées | 20 | 21 |
| Numéro bien lu | 95 % | 76 % |
| Bonne carte dans la liste | 95 % | 76 % |
| Ajout automatique correct | 95 % | 71 % |
| Ajout automatique **faux** | 0 % | 0 % |
| Erreurs techniques | 1 | 0 |
| Temps moyen par carte | 0.9 s | 1.8 s |
| **Par l'image** (17129 cartes connues) | | |
| Bonne carte en 1er | 95 % | 67 % |
| Bonne carte dans les 5 premières | 95 % | 67 % |
| Sûre (nettement devant la 2e) | 95 % | 62 % |
| Sûre mais **fausse** | 0 % | 0 % |
| Image + numéro lu | 95 % | 71 % |

## Échecs

| Mode | Carte | Extension | Attendu | Lu | Dans la liste | Choix auto |
|---|---|---|---|---|---|---|
| photo | Ramoloss (base3-55) | Fossile | 55/62 | rien | non | – |
| scan | Hypnomade (base3-23) | Fossile | 23/62 | erreur : page.evaluate: Error: Le service des cartes ne répond pas, réessaie dans un instant
    at findByNumber (http://127.0.0.1:38061/app.js?v=202610190935:212:38)
    at async identifyPhoto (http://127.0.0 | non | – |
| photo | Journaliste télé (pop2-11) | POP Série 2 | 11/17 | rien | non | – |
| photo | Latias (pop7-3) | POP Série 7 | 3/17 | rien | non | – |
| photo | Lainergie (pop7-7) | POP Série 7 | 7/17 | rien | non | – |
| photo | Lockpin (pl3-63) | Vainqueurs Suprêmes | 63/147 | rien | non | – |
