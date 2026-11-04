# Randothèque

Catalogue des randonnées, construit automatiquement à partir de fichiers GPX.
Pour chaque rando : nom, distance, dénivelés, temps estimé, IBP index, carte, profil et métadonnées du fichier.

## Utilisation rapide

Prérequis : [Node.js](https://nodejs.org) 18 ou plus récent (aucune autre installation).

```bash
npm run update   # récupère les nouveaux GPX du blog puis régénère les données
npm run serve    # ouvre la Randothèque sur http://localhost:8080
```

Vous pouvez aussi ouvrir directement `index.html` dans un navigateur.

## Mise en ligne automatique (GitHub Pages)

Le site public est hébergé gratuitement sur GitHub Pages et **se met à jour tout seul toutes les heures
(à hh:07)** : la tâche `.github/workflows/mise-a-jour.yml` lit le blog, télécharge les nouveaux GPX et résumés
audio, les enregistre dans le dépôt, régénère le site et le publie. GitHub ne garantit pas l'heure exacte de ses
tâches programmées : un passage sauté est simplement rattrapé l'heure suivante. Un commit n'est créé que s'il y a
du nouveau. L'heure de la dernière vérification est affichée en haut du site.

**Randos modifiées sur le blog** : un article modifié est relu (nom, date, IBP, animateurs…). Pour les articles de
la **première page** du blog, les GPX et audios sont en plus retéléchargés à chaque passage : un fichier remplacé
sur Google Drive est repris (même nom de fichier), et si le lien GPX change ou si l'article est remplacé par un
autre (ex. « prochaine sortie » puis article définitif), l'ancien fichier est supprimé et le nouveau prend son nom.
Personne n'a besoin de se connecter.

Mise en place (une seule fois) :

1. Créer un dépôt **public** sur GitHub (par exemple `randotheque`) et y envoyer ce dossier.
2. Dans le dépôt : **Settings > Pages > Build and deployment > Source : « GitHub Actions »**.
3. Onglet **Actions > Mise à jour horaire > Run workflow** pour la première publication.
4. Le site est alors disponible sur `https://<compte>.github.io/randotheque/`.

Pour forcer une mise à jour sans attendre : **Actions > Mise à jour horaire > Run workflow**.
En cas d'échec, GitHub envoie un e-mail au propriétaire du dépôt.

Le site n'est pas destiné aux moteurs de recherche : la page porte `<meta name="robots" content="noindex, nofollow">`
et un `robots.txt` interdit l'exploration. Sur GitHub Pages, ce fichier n'est lu par les robots qu'à la racine
du domaine (`https://<compte>.github.io/robots.txt`), c'est-à-dire dans un dépôt nommé `<compte>.github.io`.

`npm run site` prépare localement le dossier `_site/` exactement comme il sera publié.
L'interface d'administration n'est pas publiée en ligne (elle reste utilisable en local avec `npm run serve`).

## Compteur total et intégration sur le blog

Le haut du site affiche le **compteur global depuis 1977** (toutes les randos du club, d'avant 2010 comprises). Il part de la valeur
donnée par le club, **20 229 km au 3 novembre 2026** (rando de ce jour incluse), et chaque rando suivante déjà
faite et non annulée s'y ajoute. Pour changer la référence : `TOTAL_REF` dans `scripts/build.mjs`.

Le bouton **« Intégrer »** à côté du compteur donne un code HTML (balise `<iframe>`, fond sombre ou clair) à coller
sur Blogger : **Mise en page > Ajouter un gadget > HTML/JavaScript**. Le compteur affiché sur le blog
(`compteur.html`, qui lit le petit fichier `data/compteur.js`) se met à jour à chaque publication du site.

Les autres chiffres du haut de page (randonnées, kilomètres, dénivelé, années) suivent les filtres et la
recherche, avec une animation de compteur à chaque changement.

## Interface d'administration (en local)

Avec `npm run serve`, le terminal affiche une adresse secrète du type
`http://localhost:8080/admin/XXXXXXXX`. Elle donne accès, **sans mot de passe**, à une page pour :

- **ajouter** des randos en glissant des fichiers GPX (le formulaire s'ouvre pour compléter nom, date, animateurs, IBP…) ;
- **modifier** les infos affichées de n'importe quelle rando, y compris celles du blog
  (le bouton « Rétablir » remet la valeur d'origine) ;
- **supprimer** une rando : celles du blog sont masquées (onglet « Masquées », bouton « Réafficher »),
  celles ajoutées vont dans la corbeille (onglet « Corbeille », bouton « Restaurer ») ;
- **synchroniser** avec le blog pour récupérer les nouvelles sorties.

Chaque changement régénère le site en 2 à 3 secondes.

- L'adresse secrète est la seule protection : ne la partagez qu'avec les gestionnaires.
  Pour en changer, supprimez le fichier `.admin-token` et relancez `npm run serve`
  (ou imposez la vôtre avec la variable `ADMIN_TOKEN`).
- Les corrections sont enregistrées dans `data/overrides.json` : elles survivent aux synchronisations avec le blog.
- L'administration a besoin du serveur `npm run serve` : elle ne fonctionne pas sur un hébergement
  purement statique (GitHub Pages, Netlify…).

## Ajouter vos propres GPX à la main

1. Déposez vos fichiers `.gpx` dans `gpx/mes-randos/` (ou n'importe quel sous-dossier de `gpx/`).
2. Lancez `npm run build`.

Les infos sont lues dans le fichier (nom, description, auteur, date, mots-clés, logiciel…).
Pour compléter ou corriger une rando, placez à côté un fichier JSON du même nom, par exemple
`ma-rando.json` à côté de `ma-rando.gpx` :

```json
{ "name": "Le Mont Bouquet", "ibp": 58, "animateurs": "Bruno - Jean", "date": "2026-03-12", "description": "…" }
```

Les animateurs s'écrivent comme sur le blog (« Bruno - Jean », « Guy et Pierre ») ou en liste
(`["Bruno", "Jean"]`) : chaque nom apparaît ensuite dans le filtre « Animateur ».

## Ce que font les scripts

| Commande | Rôle |
|---|---|
| `npm run blog` | Lit tous les articles de https://godillotsailes.blogspot.com, repère les liens « GPX » (Google Drive, Dropbox), télécharge les fichiers dans `gpx/blog/`, les résumés audio (liens « Audio ») dans `audio/blog/`, et note les infos de la sortie (titre, date, IBP, animateurs, département, photo) dans `data/blog-catalog.json`. Seuls les articles nouveaux ou modifiés sont relus ; ceux de la première page du blog sont revérifiés à chaque fois. `--refresh` relit tout. |
| `npm run build` | Analyse chaque GPX de `gpx/` et génère `data/randos.js` + `data/tracks/`. |
| `npm run serve` | Petit serveur local. |

## Comment sont calculées les valeurs

- **Distance** : somme des distances entre points de la trace.
- **Dénivelés** : altitudes lissées sur ~60 m puis seuil de 3 m pour ignorer le bruit GPS.
  Si le fichier n'a pas d'altitudes, elles sont demandées au service altimétrique de l'IGN.
- **Temps estimé** : norme DIN 33466 (4 km/h à plat, 300 m/h en montée, 500 m/h en descente), pauses non comprises.
- **IBP index** : valeur publiée sur le blog quand elle existe. Sinon, estimation (affichée avec « ≈ »)
  par une régression calée sur les randos du blog qui ont un IBP officiel (écart moyen d'environ 2 points).
  Pour la valeur officielle, analysez le GPX sur https://www.ibpindex.com/ibpindex/analyser.php.
- **Niveau** : Vert ≤ 25 (très facile), Bleu ≤ 50 (facile), Jaune ≤ 75 (moyen), Rouge ≤ 100 (difficile), Noir au-delà.
- **Commune / département** : déduits du point de départ via geo.api.gouv.fr.

## Dans chaque fiche de rando

- **Résumé audio** : quand l'article du blog a un lien « RESUME - Audio », un lecteur (lecture/pause, avance,
  vitesse) apparaît dans la fiche ; les cartes concernées portent la mention « Audio » et le filtre
  « Contenu > Résumé audio » les regroupe.
- **Exporter la fiche en image (PNG)** : image de 1920 px façon « tableau de bord IBP » (indice, distances,
  dénivelés, altitudes, temps total / en mouvement / de pause, vitesses, répartition montée / plat / descente).
  La « fiabilité » d'IBP index n'étant pas publique, l'image indique à la place la source de l'indice (blog ou estimé).
  Sans horodatage dans le GPX, le temps estimé remplace les temps réels.
- **Analyser la trace sur ibpindex.com** : le GPX est envoyé automatiquement au formulaire d'IBP index,
  qui ouvre son analyse complète dans un nouvel onglet.

Réglages calés sur les analyses d'IBP index : pauses = vitesse lissée sur 2 min < 1 km/h ;
montée / plat / descente = tronçons de 10 m, altitude lissée sur 60 m, plat entre −1,25 % et +1,25 %.
Une altitude constante sur tout le parcours (0 m ou 30 m partout) est considérée comme absente
et remplacée par celle du service altimétrique de l'IGN.

## Limites connues

- Les GPX publiés avant 2017 sur l'ancien Dropbox public ne sont plus téléchargeables (liens morts) ;
  la liste est dans `.cache/blog/failed-downloads.json`.
- En 2017-2018 le blog n'affichait pas la valeur IBP : ces randos ont un IBP estimé.
- Les cartes et la police nécessitent une connexion internet.
