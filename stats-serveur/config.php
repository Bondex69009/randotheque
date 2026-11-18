<?php
/**
 * Statistiques des Randothèques : réglages.
 * Le mot de passe n'est pas ici (dépôt public) : il est dans secret.php, écrit au
 * déploiement à partir du secret GitHub STATS_ADMIN_PASSWORD.
 */
return array(
	'timezone'        => 'Europe/Paris',

	// Sites suivis : clé envoyée par le script de suivi => nom et chemin sur GitHub Pages.
	'sites'           => array(
		'ga' => array(
			'name' => 'Les Godillots Ailés',
			'path' => '/randotheque/',
		),
		'gm' => array(
			'name' => 'Gérard & Martine',
			'path' => '/randotheque-gerard-martine/',
		),
	),

	// Adresses autorisées à envoyer des visites et à lire les statistiques.
	'allowed_origins' => array(
		'https://bondex69009.github.io',
		'http://localhost:8080',
		'http://localhost:8090',
		'http://127.0.0.1:8080',
		'http://127.0.0.1:8090',
	),

	// Durée sans activité après laquelle une visite est terminée (minutes).
	'session_minutes' => 30,

	// Conservation des données, en mois (CNIL : 25 au maximum).
	'retention'       => 25,
);
