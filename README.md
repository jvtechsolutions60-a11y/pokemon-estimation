# Estimation de collection Pokémon

Petite appli web (100 % statique) pour estimer la valeur d'une collection de cartes Pokémon :

1. on prend la carte en photo ;
2. le numéro (ex. `4/102`) est lu dans le bas de la carte avec [Tesseract.js](https://tesseract.projectnaptha.com/), directement dans le navigateur ;
3. la carte est retrouvée via l'API gratuite [TCGdex](https://tcgdex.dev) (noms en français) avec son prix Cardmarket en euros ;
4. on l'ajoute à sa collection : état, version (normale / holo / reverse), quantité, total, export CSV.

Si la lecture du numéro échoue, on peut le saisir à la main ou chercher par nom.

## Lancer en local

Aucun build. Ouvrir `index.html` via un petit serveur :

```sh
npx http-server .
```

## Mettre en ligne (GitHub Pages)

Settings → Pages → Source : *Deploy from a branch* → branche `main`, dossier `/ (root)`.

## Limites de cette première version

- Le prix vient de la tendance Cardmarket (toutes langues confondues) fournie par TCGdex ; une carte dans une langue rare ou gradée doit être corrigée à la main (le prix unitaire est modifiable).
- La décote selon l'état est indicative.
- La collection est enregistrée dans le navigateur (localStorage) : exporter en CSV pour la garder.
