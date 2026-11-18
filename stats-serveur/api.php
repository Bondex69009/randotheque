<?php
/**
 * Statistiques des Randothèques : point d'entrée unique.
 *
 *   POST api.php?a=collect   visites et actions (envoyées par assets/stats.js des sites)
 *   POST api.php?a=login     connexion à l'espace stats (mot de passe) -> jeton
 *   GET  api.php?a=report    tableau de bord (jeton requis)
 *   GET  api.php?a=live      visiteurs des 5 dernières minutes (jeton requis)
 *   POST api.php?a=geo       installation de la base des villes, par étapes (jeton requis)
 *   POST api.php?a=logout    fin de session
 */

require __DIR__ . '/lib/core.php';
require __DIR__ . '/lib/track.php';
require __DIR__ . '/lib/geo.php';

header( 'X-Robots-Tag: noindex, nofollow' );
header( 'X-Content-Type-Options: nosniff' );
sm_cors();

$action = (string) ( $_GET['a'] ?? '' );
$method = (string) ( $_SERVER['REQUEST_METHOD'] ?? 'GET' );

function sm_body( $max = 16384 ) {
	$data = json_decode( (string) file_get_contents( 'php://input', false, null, 0, $max ), true );
	return is_array( $data ) ? $data : array();
}

function sm_site_key( $key ) {
	$key = (string) $key;
	return array_key_exists( $key, (array) sm_cfg( 'sites' ) ) ? $key : '';
}

/* -------------------------------------------------------------------------
 * Réception des visites
 * ---------------------------------------------------------------------- */

/** Actions des Randothèques comptées (toute autre valeur est ignorée). */
function sm_events() {
	return array(
		'rando'    => 'Fiches rando ouvertes',
		'gpx'      => 'GPX téléchargés',
		'fly'      => 'Survols 3D',
		'fly_duel' => 'Survols 3D en duel',
		'vs'       => 'Comparaisons VS',
		'share'    => 'Partages (image / vidéo)',
		'png'      => 'Images PNG enregistrées',
		'ibp'      => 'Calculs IBP',
		'search'   => 'Recherches',
		'filter'   => 'Filtres utilisés',
		'map'      => 'Passages en vue carte',
		'audio'    => 'Commentaires audio écoutés',
		'evo'      => 'Évolution du compteur ouverte',
		'embed'    => 'Code du compteur ouvert',
		'ailleurs' => 'Recherches « Chercher aussi sur »',
		'ext'      => 'Fiches externes ouvertes',
		'install'  => 'Installations de l\'appli',
		'outbound' => 'Liens vers d\'autres sites',
	);
}

function sm_sign( $id ) {
	return substr( hash_hmac( 'sha256', 'hit' . $id, sm_secret() ), 0, 16 );
}

function sm_collect() {
	if ( 'POST' !== ( $_SERVER['REQUEST_METHOD'] ?? '' ) ) {
		sm_done( 405 );
	}
	$data = sm_body();
	$site = sm_site_key( $data['s'] ?? '' );
	if ( ! $site ) {
		sm_done();
	}

	// Les rejets ne sont comptés qu'une fois par page vue (pas pour chaque action ou mesure de durée).
	$GLOBALS['sm_count_rejects'] = in_array( $data['t'] ?? '', array( 'pv', 'wd' ), true );

	// Robots, outils automatiques et tout ce qui n'est pas un vrai navigateur.
	$ua = substr( (string) ( $_SERVER['HTTP_USER_AGENT'] ?? '' ), 0, 512 );
	if ( sm_is_bot( $ua ) ) {
		sm_reject( $site, 'bot', sm_browser( $ua ) );
	}
	if ( ! sm_is_real_browser( $ua ) ) {
		sm_reject( $site, 'browser', sm_browser( $ua ) );
	}
	// Un vrai navigateur envoie toujours l'origine de la page (requête d'un autre site)…
	if ( empty( $_SERVER['HTTP_ORIGIN'] ) ) {
		sm_reject( $site, 'fake', 'Sans origine' );
	}
	// … et Chrome, Edge et Firefox récents ajoutent les en-têtes Sec-Fetch : un script qui
	// se fait passer pour eux en imitant seulement le User-Agent les oublie presque toujours.
	if ( preg_match( '~(Chrome|Firefox)/\d~', $ua ) && ! preg_match( '~CriOS|FxiOS|iPhone|iPad~', $ua ) && empty( $_SERVER['HTTP_SEC_FETCH_MODE'] ) ) {
		sm_reject( $site, 'fake', 'Faux navigateur' );
	}

	// L'administrateur (adresse notée à sa connexion) n'est jamais compté.
	$ip = sm_ip();
	if ( $ip && sm_is_admin_ip( $ip ) ) {
		sm_reject( $site, 'admin' );
	}

	$kind = (string) ( $data['t'] ?? '' );

	// Pays inhabituels et centres de données : faux visiteurs (contrôlé à chaque page vue ;
	// une action n'est comptée que rattachée à une visite déjà acceptée).
	$geo = null;
	if ( 'pv' === $kind || 'wd' === $kind ) {
		$geo     = sm_geo_lookup( $ip );
		$allowed = (array) sm_cfg( 'allowed_countries' );
		if ( '' !== $geo[0] && $allowed && ! in_array( $geo[0], $allowed, true ) ) {
			sm_reject( $site, 'country', $geo[0] );
		}
		$asn = sm_asn_lookup( $ip );
		if ( '' !== $asn[1] && sm_cfg( 'datacenter_pattern' ) && preg_match( sm_cfg( 'datacenter_pattern' ), $asn[1] ) ) {
			sm_reject( $site, 'datacenter', $asn[1] );
		}
	}

	// Temps passé (envoyé quand le visiteur quitte ou masque la page).
	if ( 'ping' === $kind ) {
		$id = (int) ( $data['id'] ?? 0 );
		if ( $id > 0 && hash_equals( sm_sign( $id ), (string) ( $data['k'] ?? '' ) ) ) {
			$seconds = min( 7200, max( 0, (int) ( $data['d'] ?? 0 ) ) );
			sm_q( 'UPDATE hits SET duration = ? WHERE id = ? AND duration < ?', array( $seconds, $id, $seconds ) );
		}
		sm_done();
	}
	if ( ! in_array( $kind, array( 'pv', 'ev', 'wd' ), true ) ) {
		sm_done();
	}

	$now     = date( 'Y-m-d H:i:s' );
	$visitor = substr( hash( 'sha256', sm_salt() . '|' . sm_ip_net( $ip ) . '|' . $ua . '|' . $site ), 0, 16 );
	$touch   = (int) ( $data['tc'] ?? 0 );

	$row = array(
		'site'    => $site,
		'ts'      => $now,
		'day'     => date( 'Y-m-d' ),
		'visitor' => $visitor,
		'ipk'     => sm_ip_day_key( $ip ),
	);

	// Affichage du compteur sur le blog : compté à part, sans visite.
	if ( 'wd' === $kind ) {
		$row += array(
			'type'    => 3,
			'device'  => sm_device( $ua, $touch ),
			'browser' => sm_browser( $ua ),
			'os'      => sm_os( $ua, $touch ),
			'country' => $geo[0],
			'city'    => $geo[1],
		);
		sm_insert( $row );
		sm_done();
	}

	$last = sm_q( "SELECT * FROM hits WHERE visitor = ? AND type IN (1,2) ORDER BY id DESC LIMIT 1", array( $visitor ) )->fetch();
	$same_visit = $last && ( time() - strtotime( $last['ts'] ) ) < 60 * (int) sm_cfg( 'session_minutes' );

	if ( 'ev' === $kind ) {
		$event = (string) ( $data['e'] ?? '' );
		if ( ! $last || ! array_key_exists( $event, sm_events() ) ) {
			sm_done();
		}
		$same_visit   = true; // Une action est rattachée à la dernière visite.
		$row['type']  = 2;
		$row['event'] = $event;
		$row['label'] = sm_clean_text( $data['l'] ?? '', 200 );
		$row['ref']   = sm_clean_text( $data['id'] ?? '', 120 );
		if ( 'search' === $event ) {
			$row['label'] = mb_strtolower( $row['label'] );
		}
	} else {
		$row['type']    = 1;
		$row['landing'] = in_array( $data['lg'] ?? '', array( 'accueil', 'fiche', 'vs', 'recherche', 'filtres', 'carte', 'appli' ), true ) ? $data['lg'] : 'accueil';
		$row['ref']     = sm_clean_text( $data['id'] ?? '', 120 );
		$row['label']   = sm_clean_text( $data['l'] ?? '', 200 );
	}

	if ( $same_visit ) {
		$row['is_entry'] = 0;
		foreach ( array( 'session', 'src_type', 'src_name', 'campaign', 'device', 'browser', 'os', 'country', 'city', 'lat', 'lon', 'lang', 'screen', 'theme', 'app' ) as $col ) {
			$row[ $col ] = $last[ $col ];
		}
		if ( 1 === $row['type'] ) {
			$row['landing'] = '';
		}
	} else {
		$utm    = is_array( $data['u'] ?? null ) ? $data['u'] : array();
		$ref    = (string) ( $data['r'] ?? '' );
		$source = sm_site_source( $ref, $utm, $site );
		$geo    = $geo ?: sm_geo_lookup( $ip );

		$row['is_entry'] = 1;
		$row['session']  = bin2hex( random_bytes( 8 ) );
		$row['src_type'] = $source[0];
		$row['src_name'] = mb_substr( $source[1], 0, 100 );
		$row['campaign'] = mb_substr( $source[2], 0, 100 );
		$row['device']   = sm_device( $ua, $touch );
		$row['browser']  = sm_browser( $ua );
		$row['os']       = sm_os( $ua, $touch );
		$row['country']  = $geo[0];
		$row['city']     = $geo[1];
		$row['lat']      = $geo[2];
		$row['lon']      = $geo[3];
		$row['lang']     = sm_lang( $data['lang'] ?? '' );
		$row['screen']   = sm_screen( $data['w'] ?? 0 );
		$row['theme']    = 'dark' === ( $data['th'] ?? '' ) ? 'sombre' : ( 'light' === ( $data['th'] ?? '' ) ? 'clair' : '' );
		$row['app']      = empty( $data['a'] ) ? 0 : 1;
		if ( 2 === $row['type'] ) {
			$row['is_entry'] = 0; // Une action sans page vue récente n'ouvre pas une visite.
		}
	}

	$id = sm_insert( $row );
	sm_daily_maintenance();

	if ( 1 !== $row['type'] || ! $id ) {
		sm_done();
	}
	sm_json(
		array(
			'id' => $id,
			'k'  => sm_sign( $id ),
		)
	);
}

function sm_insert( array $row ) {
	$cols = array_keys( $row );
	sm_q( 'INSERT INTO hits (' . implode( ',', $cols ) . ') VALUES (' . implode( ',', array_fill( 0, count( $cols ), '?' ) ) . ')', array_values( $row ) );
	return (int) sm_db()->lastInsertId();
}

/**
 * Origine d'une visite. Les deux Randothèques partagent le même domaine (github.io) :
 * un visiteur venu de l'autre site est une visite « Autres sites », pas un accès direct.
 */
function sm_site_source( $ref, array $utm, $site ) {
	$host  = strtolower( (string) parse_url( $ref, PHP_URL_HOST ) );
	$path  = (string) parse_url( $ref, PHP_URL_PATH );
	$sites = (array) sm_cfg( 'sites' );
	if ( 'bondex69009.github.io' === $host ) {
		foreach ( $sites as $key => $s ) {
			if ( $key !== $site && 0 === strpos( $path, $s['path'] ) ) {
				return array( 'referral', 'Randothèque ' . $s['name'], '' );
			}
		}
		return sm_source( '', $utm, $host );
	}
	return sm_source( $ref, $utm, 'bondex69009.github.io' );
}

/* -------------------------------------------------------------------------
 * Routeur
 * ---------------------------------------------------------------------- */

try {
	switch ( $action ) {
		case 'collect':
			sm_collect();
			break;

		case 'login':
			if ( 'POST' !== $method ) {
				sm_done( 405 );
			}
			$res = sm_login( (string) ( sm_body()['password'] ?? '' ) );
			if ( isset( $res['error'] ) ) {
				sm_json( array( 'error' => $res['error'] ), $res['code'] );
			}
			sm_json( $res );
			break;

		case 'logout':
			$token = sm_bearer();
			if ( $token ) {
				sm_q( 'DELETE FROM tokens WHERE hash = ?', array( hash( 'sha256', $token ) ) );
			}
			sm_done();
			break;

		case 'report':
			sm_require_admin();
			require __DIR__ . '/lib/report.php';
			$site = (string) ( $_GET['site'] ?? '' );
			$site = 'all' === $site ? 'all' : sm_site_key( $site );
			if ( ! $site ) {
				sm_json( array( 'error' => 'Site inconnu.' ), 400 );
			}
			sm_json( sm_report( $site, (string) ( $_GET['period'] ?? '30d' ), (string) ( $_GET['from'] ?? '' ), (string) ( $_GET['to'] ?? '' ) ) );
			break;

		case 'live':
			sm_require_admin();
			require __DIR__ . '/lib/report.php';
			$site = (string) ( $_GET['site'] ?? '' );
			$site = 'all' === $site ? 'all' : sm_site_key( $site );
			sm_json( sm_live( $site ?: 'all' ) );
			break;

		case 'geo':
			sm_require_admin();
			$body = sm_body();
			$res  = sm_geo_step( (string) ( $body['step'] ?? '' ), (string) ( $body['kind'] ?? 'city' ) );
			if ( is_string( $res ) ) {
				sm_json( array( 'error' => $res ), 500 );
			}
			sm_json( $res );
			break;

		default:
			http_response_code( 404 );
			header( 'Content-Type: text/plain; charset=utf-8' );
			echo 'Statistiques des Randothèques.';
	}
} catch ( Throwable $e ) {
	error_log( 'Stats Randothèques : ' . $e->getMessage() );
	sm_json( array( 'error' => 'Erreur du serveur de statistiques.' ), 500 );
}
