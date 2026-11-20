<?php
/**
 * Statistiques des Randothèques : réception des visites et des actions
 * (cookie visiteur rt_vid et position du navigateur rt_geo, envoyés par assets/stats.js).
 */

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
		'vs_add'   => 'Ajouts au comparateur',
		'anim'     => 'Clics sur un animateur',
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
		'blog'     => 'Articles du blog ouverts',
		'photos'   => 'Albums photos ouverts',
		'relive'   => 'Vidéos Relive lancées',
		'drive'    => 'Fichiers Google Drive ouverts',
		'route'    => 'Itinéraires vers le départ',
		'video'    => 'Vidéos lancées',
		'ext_site' => 'Fiches sur d\'autres sites',
		'outbound' => 'Autres liens externes',
		'ui'       => 'Autres clics et réglages',
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

	$ip = sm_ip();

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

	// Position donnée par le navigateur juste après la page vue : elle remplace la ville
	// trouvée par l'IP pour toute la visite.
	if ( 'geo' === $kind ) {
		$id  = (int) ( $data['id'] ?? 0 );
		$gps = sm_gps_clean( $data );
		if ( $id > 0 && $gps && hash_equals( sm_sign( $id ), (string) ( $data['k'] ?? '' ) ) ) {
			$session = (string) sm_q( 'SELECT session FROM hits WHERE id = ?', array( $id ) )->fetchColumn();
			if ( '' !== $session ) {
				list( $cc, $city ) = sm_reverse_geocode( $gps[0], $gps[1] );
				sm_q(
					"UPDATE hits SET lat = ?, lon = ?, acc = ?, geo = 'gps', city = CASE WHEN ? <> '' THEN ? ELSE city END,
						country = CASE WHEN ? <> '' THEN ? ELSE country END WHERE session = ?",
					array( $gps[0], $gps[1], $gps[2], $city, $city, $cc, $cc, $session )
				);
			}
		}
		sm_done();
	}

	// Temps passé (envoyé quand le visiteur quitte ou masque la page).
	if ( 'ping' === $kind ) {
		$id = (int) ( $data['id'] ?? 0 );
		if ( $id > 0 && hash_equals( sm_sign( $id ), (string) ( $data['k'] ?? '' ) ) ) {
			$seconds = min( 7200, max( 0, (int) ( $data['d'] ?? 0 ) ) );
			$scroll  = min( 100, max( 0, (int) ( $data['sd'] ?? 0 ) ) );
			sm_q( 'UPDATE hits SET duration = MAX(duration, ?), scroll = MAX(scroll, ?) WHERE id = ?', array( $seconds, $scroll, $id ) );
		}
		sm_done();
	}
	if ( ! in_array( $kind, array( 'pv', 'ev', 'wd' ), true ) ) {
		sm_done();
	}

	$now     = date( 'Y-m-d H:i:s' );
	// Visiteur : cookie rt_vid (durable) ; sans cookie, empreinte du jour (IP + navigateur).
	$vid     = preg_match( '/^[a-f0-9]{24}$/', (string) ( $data['v'] ?? '' ) ) ? (string) $data['v'] : '';
	$visitor = $vid
		? substr( hash_hmac( 'sha256', 'vid|' . $vid . '|' . $site, sm_secret() ), 0, 16 )
		: substr( hash( 'sha256', sm_salt() . '|' . sm_ip_net( $ip ) . '|' . $ua . '|' . $site ), 0, 16 );
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
		$row['btn']   = sm_clean_text( $data['b'] ?? '', 80 ); // bouton de la fiche rando, s'il y a lieu
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
		foreach ( array( 'session', 'src_type', 'src_name', 'campaign', 'device', 'browser', 'os', 'country', 'city', 'lat', 'lon', 'geo', 'acc', 'ret', 'lang', 'screen', 'theme', 'app', 'browser_v', 'os_v', 'brand', 'model', 'res', 'dpr', 'net' ) as $col ) {
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
		$row['geo']      = '' !== $geo[1] ? 'ip' : '';
		// Position du navigateur mémorisée dans le cookie rt_geo : plus précise que l'IP.
		$gps = sm_gps_clean( $data['g'] ?? null );
		if ( $gps ) {
			list( $cc, $city ) = sm_reverse_geocode( $gps[0], $gps[1] );
			$row['lat'] = $gps[0];
			$row['lon'] = $gps[1];
			$row['acc'] = $gps[2];
			$row['geo'] = 'gps';
			if ( '' !== $city ) {
				$row['city']    = $city;
				$row['country'] = $cc ? $cc : $row['country'];
			}
		}
		// Nouveau visiteur ou revenant (seulement quand le cookie est accepté).
		$row['ret'] = $vid ? ( sm_q( 'SELECT 1 FROM hits WHERE visitor = ? LIMIT 1', array( $visitor ) )->fetchColumn() ? 2 : 1 ) : 0;
		$row['lang']     = sm_lang( $data['lang'] ?? '' );
		$row['screen']   = sm_screen( $data['w'] ?? 0 );
		$row['theme']    = 'dark' === ( $data['th'] ?? '' ) ? 'sombre' : ( 'light' === ( $data['th'] ?? '' ) ? 'clair' : '' );
		$row['app']      = empty( $data['a'] ) ? 0 : 1;
		$dev             = sm_device_details( $ua, is_array( $data['ch'] ?? null ) ? $data['ch'] : array(), $touch );
		$row['browser_v'] = $dev['browser_v'];
		$row['os_v']      = $dev['os_v'];
		$row['brand']     = $dev['brand'];
		$row['model']     = $dev['model'];
		$w = (int) ( $data['w'] ?? 0 );
		$h = (int) ( $data['sh'] ?? 0 );
		$row['res']       = $w > 0 && $h > 0 && $w < 10000 && $h < 10000 ? $w . '×' . $h : '';
		$dpr              = (float) ( $data['dpr'] ?? 0 );
		$row['dpr']       = $dpr > 0 && $dpr < 10 ? rtrim( rtrim( number_format( $dpr, 2, '.', '' ), '0' ), '.' ) . 'x' : '';
		$row['net']       = in_array( $data['net'] ?? '', array( 'slow-2g', '2g', '3g', '4g' ), true ) ? strtoupper( str_replace( 'slow-', 'lent ', $data['net'] ) ) : '';
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
 * Origine d'une visite. Les deux Randothèques partagent le même domaine :
 * un visiteur venu de l'autre site est une visite « Autres sites », pas un accès direct.
 */
function sm_site_source( $ref, array $utm, $site ) {
	$host  = strtolower( (string) parse_url( $ref, PHP_URL_HOST ) );
	$path  = (string) parse_url( $ref, PHP_URL_PATH );
	$sites = (array) sm_cfg( 'sites' );
	$self  = (string) sm_cfg( 'site_host' );
	if ( $self === $host ) {
		foreach ( $sites as $key => $s ) {
			if ( $key !== $site && 0 === strpos( $path, $s['path'] ) ) {
				return array( 'referral', 'Randothèque ' . $s['name'], '' );
			}
		}
		return sm_source( '', $utm, $host );
	}
	return sm_source( $ref, $utm, $self );
}
