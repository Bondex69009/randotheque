# Randothèques

Les deux Randothèques, dans un seul dépôt, en ligne chez o2switch sur **https://randotheque.anthony-bondon.fr/**.

| Dossier du dépôt | En ligne | Contenu |
| --- | --- | --- |
| `godillots-ailes/` | `/godillots-ailes/` | Historique des randos des Godillots Ailés (A.C.R.P. Caissargues), espace stats dans `stats/` |
| `gerard-martine/` | `/gerard-martine/` | La Randothèque de Gérard & Martine, espace stats dans `stats/` |
| `stats-serveur/` | `/stats/` | Moteur des statistiques (PHP + SQLite, sans cookie) ; son `admin/` est copié dans le `stats/` de chaque site |
| `hebergement/racine/` | `/` | Page d'accueil, `robots.txt`, `.htaccess` (HTTPS forcé, pas d'indexation) |

Chaque Randothèque a son propre README (scripts, calculs, administration locale).

## Mise à jour et mise en ligne automatiques

`.github/workflows/mise-a-jour.yml` tourne toutes les heures (à hh:07), à chaque `git push` sur `main` et à la demande
(onglet *Actions* > *Mise à jour horaire* > *Run workflow*). Il lit les blogs des deux sites, enregistre les nouveaux
GPX et audios dans le dépôt, régénère les deux sites et envoie tout par FTP. Seuls les fichiers modifiés partent. Un
souci sur les blogs de Gérard & Martine ne bloque pas la mise à jour des Godillots.

L'ancienne adresse des Godillots (`bondex69009.github.io/randotheque/`) est redirigée vers le nouveau site, chemin et
`#rando=…` conservés (liens partagés, appli installée, compteur collé sur le blog). Cette redirection n'est publiée
que lorsque le nouveau site répond. L'ancien dépôt `randotheque-gerard-martine` ne sert plus qu'à la même redirection
pour son ancienne adresse.

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

## Statistiques de visite

Un espace par site, qui ne montre que ses visites (petit cadenas en haut à droite de chaque site, puis mot de passe) :
https://randotheque.anthony-bondon.fr/godillots-ailes/stats/ et https://randotheque.anthony-bondon.fr/gerard-martine/stats/.
Visiteurs, visites, fiches ouvertes, GPX téléchargés, survols 3D, duels VS, partages, recherches,
filtres, sources de trafic, villes (carte), appareils, navigateurs, affluence, durée des visites, journal des visites,
affichages du compteur sur le blog et faux visiteurs écartés.

- **Sans cookie, RGPD** : rien n'est écrit sur l'appareil des visiteurs ; les IP ne sont jamais enregistrées
  (empreinte anonyme dont la clé change chaque jour) ; données effacées après 25 mois. Pas de bandeau cookie.
- **Faux visiteurs écartés** : robots, outils automatiques, navigateurs non standard, pays hors de la liste
  `allowed_countries` de `stats-serveur/config.php`, centres de données (AWS, OVH, Hetzner…).
- **Administrateur** : son adresse est notée à chaque ouverture de l'espace stats et n'est plus comptée.
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
