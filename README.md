# CoteCartes · estimation de collection Pokémon

Petite appli web (100 % statique) pour estimer la valeur d'une collection de cartes Pokémon :

1. on prend la carte en photo ;
2. la carte est reconnue à son image : le navigateur repère la carte dans la photo et compare son empreinte (formes + couleurs, `fingerprint.js`) à celles de toutes les images officielles, calculées chaque semaine par GitHub Actions (branche `empreintes`) ;
3. si l'image ne suffit pas, le numéro (ex. `4/102`) est lu dans le bas de la carte avec [Tesseract.js](https://tesseract.projectnaptha.com/), directement dans le navigateur, et départage les cartes qui se ressemblent ;
4. la carte est retrouvée via l'API gratuite [TCGdex](https://tcgdex.dev) (noms en français) avec son prix Cardmarket en euros ;
5. on l'ajoute à sa collection : état, version (normale / holo / reverse), quantité, total, export CSV.

Si la lecture du numéro échoue, on peut le saisir à la main ou chercher par nom.

Aussi :
- **mode rafale** : plusieurs photos d'un coup, chaque carte reconnue sans ambiguïté est ajoutée en Near Mint, les autres attendent un choix ;
- **extensions** : cocher ses cartes, afficher les manquantes et estimer le coût pour compléter ;
- **courbe de valeur** : un point par jour, gardé sur l'appareil et dans le coffre chiffré du compte ;
- **appli installable** (PWA, `sw.js`) : fonctionne hors ligne avec les dernières données chargées.

## Compte anonyme et chiffré

Pas de nom, d'email, de mot de passe ni d'adresse : un compte est un **code secret** aléatoire de 20 caractères (100 bits), généré dans le navigateur.

- Le navigateur dérive du code (PBKDF2 puis HKDF) un identifiant de coffre, un jeton d'accès et une clé AES-256-GCM.
- La collection est chiffrée sur l'appareil ; le serveur ne reçoit que l'identifiant, le jeton (stocké haché en SHA-256) et le bloc chiffré.
- Le serveur ([`worker/`](worker/)) est un Cloudflare Worker + base D1, sans journal de requêtes (pas d'adresse IP conservée).
- Une fuite de la base ne révèle donc ni qui sont les utilisateurs, ni ce qu'ils possèdent.
- Contrepartie : un code perdu = une collection perdue, personne ne peut la déchiffrer.
- Anti-abus : 5 créations de compte par minute et 120 requêtes par minute par connexion (compteurs en mémoire chez Cloudflare), 1 000 comptes créés par jour au maximum.
- Conservation : un compte inutilisé pendant 2 ans est effacé chaque nuit (seul le jour de dernière utilisation est noté).
- Le même serveur relaie les images officielles (`/img/…`) pour la comparaison des éditions : `assets.tcgdex.net` envoie son en-tête CORS en double (`*, *`), que les navigateurs refusent (600 images par minute et par connexion au maximum).

Détails pour les visiteurs : [confidentialite.html](confidentialite.html).

### Activer les comptes (une seule fois)

1. Créer un compte gratuit sur [Cloudflare](https://dash.cloudflare.com/sign-up) et ouvrir *Workers & Pages* une fois (cela réserve le sous-domaine `*.workers.dev`).
2. Créer un jeton d'API (*My Profile → API Tokens → Create Token → Edit Cloudflare Workers*, en ajoutant la permission *Account → D1 → Edit*).
3. Dans GitHub : *Settings → Secrets and variables → Actions*, ajouter `CLOUDFLARE_API_TOKEN` (le jeton) et `CLOUDFLARE_ACCOUNT_ID` (visible sur le tableau de bord Cloudflare).
4. Lancer le workflow *Déployer le serveur de synchronisation* (onglet *Actions*). Il crée la base, applique le schéma et déploie le Worker.
5. Renseigner l'adresse du Worker dans `API_URL` de [`sync.js`](sync.js) (actuellement `https://pokemon-estimation-sync.jvtechsolutions60.workers.dev`).

## Tests

```sh
cd tests && npm install && npx playwright install chromium
npm test          # site complet avec des données simulées
npm run test:live # vrais services : TCGdex, images officielles, lecture du numéro
```

GitHub Actions lance les deux à chaque envoi sur `main` et chaque lundi, pour repérer un changement de TCGdex avant les utilisateurs.

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
