<?php
/**
 * Statistiques des Randothèques : données de l'espace stats.
 *
 * Le dossier admin/ est protégé par mot de passe dans cPanel
 * (« Confidentialité du répertoire ») : Apache demande l'identifiant avant PHP.
 *
 *   GET  api.php?a=report&site=ga|gm|all&period=…   tableau de bord
 *   GET  api.php?a=live&site=…                       visiteurs des 5 dernières minutes
 *   POST api.php?a=geo  {step, kind}                 installation des bases DB-IP, par étapes
 */

require dirname( __DIR__ ) . '/lib/core.php';
require dirname( __DIR__ ) . '/lib/track.php';
require dirname( __DIR__ ) . '/lib/geo.php';
require dirname( __DIR__ ) . '/lib/collect.php';
require dirname( __DIR__ ) . '/lib/report.php';

header( 'X-Robots-Tag: noindex, nofollow' );
header( 'X-Content-Type-Options: nosniff' );
sm_require_admin();

$action = (string) ( $_GET['a'] ?? '' );
$site   = (string) ( $_GET['site'] ?? 'all' );
$site   = 'all' === $site ? 'all' : sm_site_key( $site );
if ( ! $site ) {
	sm_json( array( 'error' => 'Site inconnu.' ), 400 );
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
