<?php
/**
 * Statistiques d'UNE Randothèque : données de son espace stats.
 *
 * Ce dossier est copié dans chaque site (godillots-ailes/stats/, gerard-martine/stats/) : le site
 * affiché est celui du dossier où il est installé. Le moteur commun (bases, réception des visites)
 * est dans /stats/ à la racine du sous-domaine.
 *
 * Chaque dossier stats/ est protégé par mot de passe dans cPanel (« Confidentialité du répertoire ») :
 * Apache demande l'identifiant avant PHP.
 *
 *   GET  api.php?a=report&period=…      tableau de bord
 *   GET  api.php?a=live                 visiteurs des 5 dernières minutes
 *   POST api.php?a=geo  {step, kind}    installation des bases DB-IP, par étapes
 */

$sm_lib = rtrim( (string) ( $_SERVER['DOCUMENT_ROOT'] ?? '' ), '/' ) . '/stats/lib';
if ( ! is_file( $sm_lib . '/core.php' ) ) {
	http_response_code( 503 );
	header( 'Content-Type: application/json; charset=utf-8' );
	echo json_encode( array( 'error' => 'Le moteur des statistiques (dossier /stats/ du sous-domaine) n\'est pas encore en ligne : il part avec la prochaine mise à jour.' ), JSON_UNESCAPED_UNICODE );
	exit;
}
require $sm_lib . '/core.php';
require $sm_lib . '/track.php';
require $sm_lib . '/geo.php';
require $sm_lib . '/collect.php';
require $sm_lib . '/report.php';

header( 'X-Robots-Tag: noindex, nofollow' );
header( 'X-Content-Type-Options: nosniff' );
sm_require_admin();

$action = (string) ( $_GET['a'] ?? '' );

// Site = dossier où se trouve cet espace (/godillots-ailes/stats/ -> ga, /gerard-martine/stats/ -> gm).
$site   = '';
$script = (string) ( $_SERVER['SCRIPT_NAME'] ?? '' );
foreach ( (array) sm_cfg( 'sites' ) as $key => $info ) {
	if ( 0 === strpos( $script, $info['path'] ) ) {
		$site = $key;
	}
}
if ( ! $site ) {
	sm_json( array( 'error' => 'Espace stats installé hors du dossier d\'un site.' ), 400 );
}

try {
	switch ( $action ) {
		case 'report':
			sm_json( sm_report( $site, (string) ( $_GET['period'] ?? '30d' ), (string) ( $_GET['from'] ?? '' ), (string) ( $_GET['to'] ?? '' ) ) );
			break;

		case 'live':
			sm_json( sm_live( $site ) );
			break;

		case 'geo':
			if ( 'POST' !== ( $_SERVER['REQUEST_METHOD'] ?? '' ) ) {
				sm_done( 405 );
			}
			$body = sm_body();
			$res  = sm_geo_step( (string) ( $body['step'] ?? '' ), (string) ( $body['kind'] ?? 'city' ) );
			if ( is_string( $res ) ) {
				sm_json( array( 'error' => $res ), 500 );
			}
			sm_json( $res );
			break;

		default:
			sm_json( array( 'error' => 'Action inconnue.' ), 404 );
	}
} catch ( Throwable $e ) {
	error_log( 'Stats Randothèques : ' . $e->getMessage() );
	sm_json( array( 'error' => 'Erreur du serveur de statistiques.' ), 500 );
}
