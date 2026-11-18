<?php
/**
 * Statistiques des Randothèques : réglages.
 * Le mot de passe n'est pas ici (dépôt public) : il est dans secret.php, écrit au
 * déploiement à partir du secret GitHub STATS_ADMIN_PASSWORD.
 */
return array(
	'timezone'        => 'Europe/Paris',

	// Domaine des deux sites (même sous-domaine o2switch, un dossier chacun).
	'site_host'       => 'randotheque.anthony-bondon.fr',

	// Sites suivis : clé envoyée par le script de suivi => nom et dossier sur le sous-domaine.
	'sites'           => array(
		'ga' => array(
			'name' => 'Les Godillots Ailés',
			'path' => '/godillots-ailes/',
		),
		'gm' => array(
			'name' => 'Gérard & Martine',
			'path' => '/gerard-martine/',
		),
	),

	// Adresses autorisées à envoyer des visites et à lire les statistiques.
	'allowed_origins' => array(
		'https://randotheque.anthony-bondon.fr',
		'http://localhost:8080',
		'http://localhost:8090',
		'http://127.0.0.1:8080',
		'http://127.0.0.1:8090',
	),

	// Pays d'où les visites sont comptées (codes ISO). Les autres sont considérées comme du faux
	// trafic (robots, fermes de clics) et écartées. Une visite dont le pays est inconnu est gardée.
	// Europe, Amérique du Nord, Maghreb, outre-mer français, Australie / Nouvelle-Zélande.
	'allowed_countries' => array(
		'FR', 'BE', 'CH', 'LU', 'MC', 'AD', 'ES', 'IT', 'PT', 'DE', 'AT', 'NL', 'GB', 'IE', 'DK', 'SE', 'NO', 'FI', 'IS',
		'PL', 'CZ', 'SK', 'HU', 'SI', 'HR', 'GR', 'MT', 'CY', 'EE', 'LV', 'LT', 'RO', 'BG', 'LI', 'SM', 'VA',
		'US', 'CA',
		'MA', 'TN', 'DZ',
		'RE', 'GP', 'MQ', 'GF', 'YT', 'NC', 'PF', 'PM', 'BL', 'MF', 'WF',
		'AU', 'NZ',
	),

	// Hébergeurs et centres de données : un vrai randonneur ne navigue pas depuis un serveur.
	// Reconnus par le nom de l'opérateur réseau (base DB-IP ASN Lite). Pas Cloudflare, Akamai
	// ni Fastly : ils transportent aussi les vrais visiteurs (Relais privé iCloud, WARP).
	'datacenter_pattern' => '~amazon|aws|google cloud|google llc|microsoft|azure|ovh|hetzner|digitalocean|linode|akamai connected cloud|vultr|choopa|constant company|scaleway|online s\.a\.s|contabo|oracle|alibaba|tencent|huawei cloud|m247|leaseweb|ionos|1&1|hostinger|hostwinds|colocrossing|datacamp|cdn77|g-core|gcore|packet|equinix|servers\.com|psychz|quadranet|kamatera|upcloud|netcup|ionos|o2switch|ikoula|hivelocity|zenlayer|tzulo|clouvider|worldstream|nforce|serverion|limestone|buyvm|frantech|racknerd|cogent|hurricane electric|selectel|timeweb|yandex|baidu|bytedance|hosting|datacenter|data center|server~i',

	// En-tête qui porte l'IP réelle quand le serveur est derrière un proxy (ex. 'HTTP_CF_CONNECTING_IP'
	// si le sous-domaine passe un jour en nuage orange chez Cloudflare). Vide : connexion directe.
	'proxy_header'    => '',

	// Durée sans activité après laquelle une visite est terminée (minutes).
	'session_minutes' => 30,

	// Conservation des données, en mois (CNIL : 25 au maximum).
	'retention'       => 25,
);
