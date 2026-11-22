<?php
/**
 * Outil « Relive 3D » : enregistre les GPX importés et leur survol 3D (historique commun à tous les appareils).
 *
 * Même mot de passe que les espaces stats (moteur /stats/lib/core.php, jeton dans l'en-tête X-Stats-Token).
 * Seule la lecture d'un survol (a=get) est publique : c'est elle que charge survol.html, intégré sur les blogs.
 *
 *   POST api.php?a=login   {password}            connexion -> jeton
 *   POST api.php?a=logout                        déconnexion
 *   GET  api.php?a=get&id=…                      survol (infos + trace), public
 *   GET  api.php?a=list                          historique (sans les traces)
 *   GET  api.php?a=gpx&id=…                      GPX d'origine (téléchargement)
 *   POST api.php?a=save    {gpx, fileName, info, track}   nouvel import -> {item}
 *   POST api.php?a=update  {id, info}            modifier le nom, la commune, la date, la couleur
 *   POST api.php?a=delete  {id}                  supprimer un import
 *
 * Fichiers : data/<id>.json (infos + trace simplifiée) et data/<id>.gpx (fichier d'origine).
 * Le dossier data/ est créé ici, fermé au web (.htaccess), et jamais envoyé ni effacé par le déploiement.
 */

$sm_lib = rtrim( (string) ( $_SERVER['DOCUMENT_ROOT'] ?? '' ), '/' ) . '/stats/lib';
if ( ! is_file( $sm_lib . '/core.php' ) ) {
	http_response_code( 503 );
	header( 'Content-Type: application/json; charset=utf-8' );
	echo json_encode( array( 'error' => 'Le moteur commun (dossier /stats/ du sous-domaine) n\'est pas en ligne.' ), JSON_UNESCAPED_UNICODE );
	exit;
}
require $sm_lib . '/core.php';

header( 'X-Robots-Tag: noindex, nofollow' );
header( 'X-Content-Type-Options: nosniff' );

define( 'RL_DATA', __DIR__ . '/data' );
define( 'RL_MAX_GPX', 15 * 1024 * 1024 );
define( 'RL_MAX_POINTS', 5000 );

function rl_body() {
	$raw = file_get_contents( 'php://input', false, null, 0, RL_MAX_GPX * 2 + 2000000 );
	$b   = json_decode( (string) $raw, true );
	return is_array( $b ) ? $b : array();
}

function rl_id( $id ) {
	$id = (string) $id;
	return preg_match( '/^[a-f0-9]{12}$/', $id ) ? $id : '';
}

function rl_dir() {
	if ( ! is_dir( RL_DATA ) ) {
		@mkdir( RL_DATA, 0755, true );
	}
	sm_protect_dir( RL_DATA );
	return RL_DATA;
}

function rl_read( $id ) {
	$f = RL_DATA . '/' . $id . '.json';
	if ( ! $id || ! is_file( $f ) ) {
		return null;
	}
	$d = json_decode( (string) file_get_contents( $f ), true );
	return is_array( $d ) ? $d : null;
}

function rl_write( array $item ) {
	$f   = rl_dir() . '/' . $item['id'] . '.json';
	$tmp = $f . '.tmp';
	file_put_contents( $tmp, json_encode( $item, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES ) );
	rename( $tmp, $f );
}

/** Infos modifiables, nettoyées (aucune balise, longueurs bornées). */
function rl_info( array $in, array $base = array() ) {
	$out = $base;
	foreach ( array( 'name' => 120, 'commune' => 120, 'place' => 160 ) as $k => $max ) {
		if ( array_key_exists( $k, $in ) ) {
			$out[ $k ] = sm_clean_text( $in[ $k ], $max );
		}
	}
	if ( array_key_exists( 'date', $in ) ) {
		$out['date'] = preg_match( '/^\d{4}-\d{2}-\d{2}$/', (string) $in['date'] ) ? (string) $in['date'] : '';
	}
	if ( array_key_exists( 'color', $in ) ) {
		$out['color'] = preg_match( '/^#[0-9a-f]{6}$/i', (string) $in['color'] ) ? strtolower( $in['color'] ) : '';
	}
	foreach ( array( 'distanceKm', 'dplus', 'dminus', 'durationMin', 'altMin', 'altMax' ) as $k ) {
		if ( array_key_exists( $k, $in ) ) {
			$out[ $k ] = is_numeric( $in[ $k ] ) ? round( (float) $in[ $k ], 2 ) : null;
		}
	}
	foreach ( array( 'loop', 'inFrance', 'recorded' ) as $k ) {
		if ( array_key_exists( $k, $in ) ) {
			$out[ $k ] = (bool) $in[ $k ];
		}
	}
	if ( array_key_exists( 'start', $in ) ) {
		$s            = (array) $in['start'];
		$out['start'] = ( isset( $s[0], $s[1] ) && is_numeric( $s[0] ) && is_numeric( $s[1] ) ) ? array( round( (float) $s[0], 5 ), round( (float) $s[1], 5 ) ) : null;
	}
	if ( '' === ( $out['name'] ?? '' ) ) {
		$out['name'] = 'Randonnée';
	}
	return $out;
}

/** Trace [[lat, lon, alt|null, km, s?], …] : nombres seulement, ordre des km croissant. */
function rl_track( $t ) {
	if ( ! is_array( $t ) || count( $t ) < 2 || count( $t ) > RL_MAX_POINTS ) {
		return null;
	}
	$out  = array();
	$last = -1;
	foreach ( $t as $p ) {
		if ( ! is_array( $p ) || count( $p ) < 4 || ! is_numeric( $p[0] ) || ! is_numeric( $p[1] ) || ! is_numeric( $p[3] ) ) {
			return null;
		}
		$lat = (float) $p[0];
		$lon = (float) $p[1];
		$km  = (float) $p[3];
		if ( abs( $lat ) > 90 || abs( $lon ) > 180 || $km < $last ) {
			return null;
		}
		$last = $km;
		$row  = array( round( $lat, 5 ), round( $lon, 5 ), is_numeric( $p[2] ?? null ) ? (int) round( (float) $p[2] ) : null, round( $km, 3 ) );
		if ( array_key_exists( 4, $p ) ) {
			$row[] = is_numeric( $p[4] ) ? (int) $p[4] : null;
		}
		$out[] = $row;
	}
	return $out;
}

/** Résumé pour l'historique (sans la trace). */
function rl_summary( array $d ) {
	unset( $d['track'] );
	return $d;
}

$action = (string) ( $_GET['a'] ?? '' );
$post   = 'POST' === ( $_SERVER['REQUEST_METHOD'] ?? '' );

// ---------------------------------------------------------------- Public : lecture d'un survol
if ( 'get' === $action ) {
	$d = rl_read( rl_id( $_GET['id'] ?? '' ) );
	if ( ! $d ) {
		sm_json( array( 'error' => 'Survol introuvable.' ), 404 );
	}
	unset( $d['fileName'] );
	http_response_code( 200 );
	header( 'Content-Type: application/json; charset=utf-8' );
	header( 'Cache-Control: public, max-age=300' );
	echo json_encode( $d, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
	exit;
}

header( 'Cache-Control: no-store' );

if ( 'login' === $action ) {
	if ( ! $post ) {
		sm_done( 405 );
	}
	$res = sm_login( (string) ( rl_body()['password'] ?? '' ) );
	if ( isset( $res['error'] ) ) {
		sm_json( array( 'error' => $res['error'] ), $res['code'] );
	}
	sm_json( $res );
}
if ( 'logout' === $action ) {
	sm_logout();
	sm_done();
}

sm_require_admin();

switch ( $action ) {
	case 'list':
		$items = array();
		foreach ( glob( RL_DATA . '/*.json' ) ?: array() as $f ) {
			$d = json_decode( (string) file_get_contents( $f ), true );
			if ( is_array( $d ) && ! empty( $d['id'] ) ) {
				$items[] = rl_summary( $d );
			}
		}
		usort( $items, function ( $a, $b ) {
			return strcmp( (string) ( $b['created'] ?? '' ), (string) ( $a['created'] ?? '' ) );
		} );
		sm_json( array( 'items' => $items ) );
		break;

	case 'gpx':
		$id = rl_id( $_GET['id'] ?? '' );
		$d  = rl_read( $id );
		$f  = RL_DATA . '/' . $id . '.gpx';
		if ( ! $d || ! is_file( $f ) ) {
			sm_json( array( 'error' => 'GPX introuvable.' ), 404 );
		}
		$name = preg_replace( '/[^\w.\- ]+/u', '_', (string) ( $d['fileName'] ?? ( $id . '.gpx' ) ) );
		header( 'Content-Type: application/gpx+xml' );
		header( 'Content-Disposition: attachment; filename="' . $name . '"' );
		header( 'Content-Length: ' . filesize( $f ) );
		readfile( $f );
		exit;

	case 'save':
		if ( ! $post ) {
			sm_done( 405 );
		}
		$b   = rl_body();
		$gpx = (string) ( $b['gpx'] ?? '' );
		if ( '' === $gpx || strlen( $gpx ) > RL_MAX_GPX || ! preg_match( '/<gpx[\s>]/i', substr( $gpx, 0, 4096 ) ) ) {
			sm_json( array( 'error' => 'Fichier GPX invalide ou trop lourd (15 Mo au plus).' ), 400 );
		}
		$track = rl_track( $b['track'] ?? null );
		if ( ! $track ) {
			sm_json( array( 'error' => 'Trace illisible.' ), 400 );
		}
		$id   = bin2hex( random_bytes( 6 ) );
		$now  = gmdate( 'c' );
		$item = array_merge(
			array( 'id' => $id, 'created' => $now, 'updated' => $now ),
			rl_info( (array) ( $b['info'] ?? array() ) ),
			array(
				'fileName' => sm_clean_text( $b['fileName'] ?? 'trace.gpx', 160 ),
				'points'   => count( $track ),
				'track'    => $track,
			)
		);
		file_put_contents( rl_dir() . '/' . $id . '.gpx', $gpx );
		rl_write( $item );
		sm_json( array( 'item' => rl_summary( $item ) ) );
		break;

	case 'update':
		if ( ! $post ) {
			sm_done( 405 );
		}
		$b = rl_body();
		$d = rl_read( rl_id( $b['id'] ?? '' ) );
		if ( ! $d ) {
			sm_json( array( 'error' => 'Survol introuvable.' ), 404 );
		}
		$in = array_intersect_key( (array) ( $b['info'] ?? array() ), array_flip( array( 'name', 'commune', 'place', 'date', 'color' ) ) );
		$d  = rl_info( $in, $d );
		$d['updated'] = gmdate( 'c' );
		rl_write( $d );
		sm_json( array( 'item' => rl_summary( $d ) ) );
		break;

	case 'delete':
		if ( ! $post ) {
			sm_done( 405 );
		}
		$id = rl_id( rl_body()['id'] ?? '' );
		if ( ! $id || ! is_file( RL_DATA . '/' . $id . '.json' ) ) {
			sm_json( array( 'error' => 'Survol introuvable.' ), 404 );
		}
		@unlink( RL_DATA . '/' . $id . '.json' );
		@unlink( RL_DATA . '/' . $id . '.gpx' );
		sm_done();
		break;

	default:
		sm_json( array( 'error' => 'Action inconnue.' ), 400 );
}
