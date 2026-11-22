# Randothèques

Les deux Randothèques, dans un seul dépôt, en ligne chez o2switch sur **https://randotheque.anthony-bondon.fr/**.

| Dossier du dépôt | En ligne | Contenu |
| --- | --- | --- |
| `godillots-ailes/` | `/godillots-ailes/` | Historique des randos des Godillots Ailés (A.C.R.P. Caissargues), espace stats dans `stats/` |
| `gerard-martine/` | `/gerard-martine/` | La Randothèque de Gérard & Martine, espace stats dans `stats/` |
| `stats-serveur/` | `/stats/` | Moteur des statistiques (PHP + SQLite, avec cookies) ; son `admin/` est copié dans le `stats/` de chaque site |
| `hebergement/racine/` | `/` | Page d'accueil, `robots.txt`, `.htaccess` (HTTPS forcé, pas d'indexation) |
| `hebergement/racine/outils/` | `/outils/` | Page des outils : une icône façon appli par outil (Tableau de bord GPX, Relive 3D) |
| `hebergement/racine/outils/ibp/` | `/outils/ibp/` | Tableau de bord GPX : lit un rapport PDF IBP index et en fait un visuel PNG à partager (page autonome, sans étape de construction) |

Chaque Randothèque a son propre README (scripts, calculs, administration locale).

## Mise à jour et mise en ligne automatiques

`.github/workflows/mise-a-jour.yml` tourne toutes les heures (à hh:07), à chaque `git push` sur `main` et à la demande
(onglet *Actions* > *Mise à jour horaire* > *Run workflow*). Il lit les blogs des deux sites, enregistre les nouveaux
GPX et audios dans le dépôt, régénère les deux sites et envoie tout par FTP. Seuls les fichiers modifiés partent. Un
souci sur les blogs de Gérard & Martine ne bloque pas la mise à jour des Godillots.

La mise en production se fait uniquement par ce FTP vers o2switch : un `git push` sur `main` suffit, ou *Run workflow*
pour forcer un passage. La dernière étape vérifie que les pages du site répondent (avertissement sinon).

GitHub Pages n'est plus utilisé. Les anciennes adresses (`bondex69009.github.io/randotheque/` et
`bondex69009.github.io/randotheque-gerard-martine/`) servent toujours la page de redirection publiée en dernier
(chemin et `#rando=…` conservés) : il ne faut donc pas désactiver Pages dans les réglages de ces deux dépôts tant que
d'anciens liens circulent. L'ancien dépôt `randotheque-gerard-martine` n'a plus aucune tâche automatique.

## Mise en place chez o2switch (une seule fois)

1. **cPanel > Domaines** : sous-domaine `randotheque.anthony-bondon.fr`.
2. **Cloudflare** (DNS de `anthony-bondon.fr`) : enregistrement `A` `randotheque` vers l'IP partagée o2switch, en
   **DNS only** (nuage gris). Puis cPanel > *SSL/TLS Status* : certificat du sous-domaine.
3. **cPanel > Comptes FTP** : un compte dont le **Répertoire** est exactement la racine du sous-domaine
   (`randotheque.anthony-bondon.fr`, rien après).
4. **GitHub**, ce dépôt > *Settings > Secrets and variables > Actions* : `FTP_HOST` (`xxx.o2switch.net`),
   `FTP_USER` (`nom@anthony-bondon.fr`), `FTP_PASSWORD`.
5. *Actions* > *Mise à jour horaire* > *Run workflow*. Le premier envoi (environ 4 000 fichiers) prend un moment.
6. Ouvrir l'un des deux espaces stats et cliquer en bas sur **Installer les bases des villes et des hébergeurs**
   (bases DB-IP gratuites, communes aux deux sites, à refaire une fois par mois).

## Outils communs aux deux sites

Ces fichiers sont identiques dans `godillots-ailes/` et `gerard-martine/` (à modifier dans les deux) :

| Fichier | Rôle |
| --- | --- |
| `assets/meteo.js` | Panneau « Météo et soleil » de la fiche : prévision Open-Meteo jusqu'à 15 jours (heure par heure pendant la rando, conseils), météo observée pour les randos passées, lever et coucher du soleil calculés sur place, heure de départ réglable et arrivée estimée (pauses au rythme des sorties enregistrées). La dernière météo reçue reste lisible sans réseau. |
| `assets/chaleur.js` | Bouton « Carte de chaleur » sur la vue carte : toutes les traces de la sélection superposées (`data/chaleur.js`, chargé au premier clic). |
| `assets/terrain.js` + `sw.js` | « Mode terrain » : carte plein écran, position GPS, km et D+ restants, arrivée estimée face au coucher du soleil, alerte si l'on quitte la trace. « Emporter hors ligne » garde la fiche, la trace et le fond IGN (zooms 11 à 16) dans le cache `rt-terrain:…` du navigateur ; le service worker les ressert sans réseau. |
| `assets/guidage.js` + `scripts/carrefours.mjs` | Guidage pas à pas du mode terrain, à l'écran et à la voix (synthèse vocale du téléphone, sans réseau). Il ne parle qu'aux croisements et fourches, là où l'on peut se tromper (« Au croisement, tournez à gauche », « À la fourche, restez à droite », « Tout droit au croisement ») ; entre deux, seulement la distance jusqu'au prochain croisement et le relief. Les croisements viennent de la BD TOPO de l'IGN (OpenStreetMap hors de France), calculés une fois par trace par la mise à jour horaire (80 nouvelles traces au plus par passage), gardés dans `.cache/carrefours/` et ajoutés aux fichiers `data/tracks/`. Alertes hors trace et mauvais sens, feuille de route complète. |
| `survol.html` + `assets/flyover.js` | Survol 3D d'une rando à mettre sur un blog : bouton « Intégrer » du lecteur 3D, qui donne un code `<iframe>` à coller dans la vue HTML d'un message Blogger. Avant le clic, la page affiche une image d'attente : la photo aérienne autour de la trace (IGN, Esri hors de France), la trace et le départ, en perspective comme au début du survol, avec un bouton « Lancer le survol » ; seuls la trace et quelques tuiles photo sont chargées. MapLibre et les données arrivent au clic, avec le randonneur qui marche pendant le chargement. Seul le nom de la rando diffère entre les deux sites (à modifier dans les deux). Bouton « Visuel » du lecteur : randonneur 3D, godillot ailé qui bat des ailes ou point simple (choix gardé sur l'appareil, aussi en duel). |
| `assets/promeneur.js` | Le randonneur qui se promène sur la page : un clic sur lui et il chante la comptine « Un kilomètre à pied » dans une bulle, avec une petite mélodie (un kilomètre de plus à chaque fois). |
| `assets/theme.js` | Bouton soleil / lune : thème automatique (comme l'appareil), clair ou sombre. Les couleurs claires sont à la fin du `style.css` de chaque site. |
| `assets/outils.css` | Styles de ces quatre outils. |
| `scripts/lib/compact.mjs` | Écriture compacte de `data/randos.js` (formes et profils des cartes), décodée à la fin du fichier : environ 35 % de moins à télécharger. Leaflet n'est plus chargé avec la page mais à la demande. |
| `scripts/controle.mjs` | Contrôle des données à chaque mise à jour horaire (GPX illisibles, liens GPX morts, traces coupées ou sans altitude, IBP à vérifier, doublons…) : rapport `data/controle.json`, affiché en bas de l'espace stats (« Contrôle des données »). |

## Outil Relive 3D

https://randotheque.anthony-bondon.fr/outils/relive-3D/ : importer un GPX (choisi ou glissé), voir son survol 3D, puis
copier le code `<iframe>` à coller dans la vue HTML d'un message Blogger. Le lecteur est **celui des Randothèques**
(`godillots-ailes/assets/flyover.js`, `flyover.css`, `style.css`, `meteo.js`, chargés directement depuis
`/godillots-ailes/assets/`) : toute évolution du survol 3D du site s'applique aussi à l'outil. `hebergement/racine/outils/relive-3D/survol.html`
reprend `survol.html` des sites (image d'attente, bouton de lecture) : à garder en phase.

- **Calculs** faits dans le navigateur, comme la mise à jour des sites (`assets/relive.js`, d'après `scripts/lib/gpx.mjs`) :
  distance, D+ / D-, temps de marche (enregistré si le GPX est horodaté, sinon norme DIN), boucle, trace simplifiée
  à 1 500 points. Altitudes absentes ou fictives : relief IGN (Géoplateforme). Commune du départ proposée par
  la Géoplateforme IGN (Nominatim hors de France), modifiable, comme le nom, la date (météo du jour) et la couleur.
- **Historique** sur le serveur, commun à tous les appareils : voir, copier le code, ouvrir la page à intégrer,
  télécharger le GPX d'origine, modifier, supprimer. Un code déjà collé sur un blog reste valable après une
  modification (le nom affiché suit) ; après une suppression, le blog affiche « Ce survol 3D n'existe plus ».
- **Accès** : même mot de passe que les espaces stats (et même connexion de 30 jours). Seule la lecture d'un survol
  (`api.php?a=get`, utilisée par `survol.html`) est publique.
- **Fichiers** : `hebergement/racine/outils/relive-3D/`, envoyé avec la page d'accueil. Son `api.php` range chaque import
  dans `data/` sur le serveur (`<id>.gpx` d'origine et `<id>.json` : infos et trace), dossier fermé au web, jamais
  envoyé ni effacé par le déploiement (absent du dépôt). Il s'appuie sur `/stats/lib/core.php`.
- **En local** : comme pour les stats, servir un dossier qui reproduit le sous-domaine, avec en plus `hebergement/racine/outils` en `outils/`
  (`godillots-ailes` peut y être le dossier source : il contient `assets/`).

## Statistiques de visite

Un espace par site, qui ne montre que ses visites (petit cadenas en haut à droite de chaque site, puis mot de passe) :
https://randotheque.anthony-bondon.fr/godillots-ailes/stats/ et https://randotheque.anthony-bondon.fr/gerard-martine/stats/.
Visiteurs, visites, fiches ouvertes, GPX téléchargés, survols 3D, duels VS, partages, recherches,
filtres, sources de trafic, villes (carte), appareils, navigateurs, affluence, durée des visites, journal des visites,
affichages du compteur sur le blog et visiteurs en temps réel.

- **Avec cookies** (intranet personnel, pas de bandeau) : `rt_vid`, identifiant aléatoire de 13 mois qui reconnaît
  un visiteur d'un jour à l'autre (nouveaux / revenants) ; `rt_geo`, position donnée par le navigateur. La fenêtre
  « Autoriser la position » s'affiche une seule fois ; si elle est acceptée, la position est rafraîchie sans fenêtre
  une fois par jour et la commune (ou l'arrondissement / le quartier) est retrouvée par la Géoplateforme IGN, Nominatim
  hors de France (cache de 6 mois par carré de ~100 m). Un refus est retenu 13 mois et la ville vient alors de l'IP.
  Les IP ne sont pas enregistrées ; navigateur sans cookie : empreinte du jour. Données effacées après 25 mois.
- **Faux visiteurs écartés** : robots, outils automatiques, navigateurs non standard, pays hors de la liste
  `allowed_countries` de `stats-serveur/config.php`, centres de données (AWS, OVH, Hetzner…).
- **Toutes les interactions** : fiches, GPX, survols 3D, duels, partages, recherches, filtres, audios, et chaque lien
  externe rangé par destination (article du blog, album photos, vidéo Relive, Google Drive, itinéraire, autres sites),
  plus tous les autres clics et réglages (boutons, fond de carte…) et la profondeur de lecture des pages.
- **Appareils** : navigateur et version, système et version, marque et modèle (quand le navigateur le donne),
  résolution et densité d'écran, type de réseau.
- **Administrateur** : compté comme tout le monde.
- **Mot de passe** : un champ sur la page, le même pour les deux sites. Seule son empreinte bcrypt est conservée
  (`password_hash` dans `stats-serveur/config.php`, avec la commande pour le changer). 8 essais ratés bloquent
  l'adresse un quart d'heure. Une fois connecté, le navigateur reste connecté 30 jours.

Fichiers : `stats-serveur/collect.php` reçoit les visites envoyées par `assets/stats.js` de chaque site ;
`stats-serveur/admin/` contient le tableau de bord et son `api.php`, copiés par `npm run site` dans le dossier `stats/`
de chaque site (le site affiché est celui du dossier) ; `stats-serveur/data/` (base SQLite, bases DB-IP)
est créé sur le serveur et n'est jamais envoyé ni effacé par le déploiement.

**En local** : construire les deux sites (`npm run site` dans chaque dossier), puis servir un dossier qui reproduit
le sous-domaine (`godillots-ailes/_site` en `godillots-ailes/`, `gerard-martine/_site` en `gerard-martine/`,
`stats-serveur` en `stats/`) avec `php -S localhost:8095 -t <dossier>`.
