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

Le site public est hébergé gratuitement sur GitHub Pages et **se met à jour tout seul chaque nuit à 4h
(heure de Paris, été comme hiver)** : la tâche `.github/workflows/mise-a-jour.yml` lit le blog,
télécharge les nouveaux GPX, les enregistre dans le dépôt, régénère le site et le publie.
Personne n'a besoin de se connecter.

Mise en place (une seule fois) :

1. Créer un dépôt **public** sur GitHub (par exemple `randotheque`) et y envoyer ce dossier.
2. Dans le dépôt : **Settings > Pages > Build and deployment > Source : « GitHub Actions »**.
3. Onglet **Actions > Mise à jour quotidienne > Run workflow** pour la première publication.
4. Le site est alors disponible sur `https://<compte>.github.io/randotheque/`.

GitHub peut décaler de quelques minutes les tâches programmées lorsque ses serveurs sont chargés.
Pour forcer une mise à jour sans attendre le lendemain : **Actions > Mise à jour quotidienne > Run workflow**.
En cas d'échec, GitHub envoie un e-mail au propriétaire du dépôt.

Le site n'est pas destiné aux moteurs de recherche : la page porte `<meta name="robots" content="noindex, nofollow">`
et un `robots.txt` interdit l'exploration. Sur GitHub Pages, ce fichier n'est lu par les robots qu'à la racine
du domaine (`https://<compte>.github.io/robots.txt`), c'est-à-dire dans un dépôt nommé `<compte>.github.io`.

`npm run site` prépare localement le dossier `_site/` exactement comme il sera publié.
L'interface d'administration n'est pas publiée en ligne (elle reste utilisable en local avec `npm run serve`).

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
| `npm run blog` | Lit tous les articles de https://godillotsailes.blogspot.com, repère les liens « GPX » (Google Drive, Dropbox), télécharge les fichiers dans `gpx/blog/` et note les infos de la sortie (titre, date, IBP, animateurs, département, photo) dans `data/blog-catalog.json`. Seuls les nouveaux articles sont relus. `--refresh` relit tout. |
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

## Limites connues

- Les GPX publiés avant 2017 sur l'ancien Dropbox public ne sont plus téléchargeables (liens morts) ;
  la liste est dans `.cache/blog/failed-downloads.json`.
- En 2017-2018 le blog n'affichait pas la valeur IBP : ces randos ont un IBP estimé.
- Les cartes et la police nécessitent une connexion internet.
