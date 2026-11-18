<?php
/**
 * Statistiques des Randothèques : réception des visites et actions envoyées par
 * assets/stats.js des deux sites (POST uniquement, jamais d'affichage).
 */

require __DIR__ . '/lib/core.php';
require __DIR__ . '/lib/track.php';
require __DIR__ . '/lib/geo.php';
require __DIR__ . '/lib/collect.php';

header( 'X-Robots-Tag: noindex, nofollow' );
header( 'X-Content-Type-Options: nosniff' );
header( 'Cache-Control: no-store' );
sm_cors();

try {
	sm_collect();
} catch ( Throwable $e ) {
	error_log( 'Stats Randothèques : ' . $e->getMessage() );
	sm_done( 500 );
}
