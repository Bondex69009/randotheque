<?php
/**
 * Géolocalisation (pays + ville).
 *
 * 1. Position donnée par le navigateur quand le visiteur l'a autorisée (cookie rt_geo) :
 *    commune retrouvée par la Géoplateforme IGN (France) ou Nominatim (ailleurs).
 * 2. Sinon, l'adresse IP, cherchée dans une base locale (DB-IP « City Lite » ou
 *    GeoLite2 de MaxMind), puis oubliée.
 */

function sm_geo_file( $kind = 'city' ) {
	return SM_DATA . '/geo-' . ( 'asn' === $kind ? 'asn' : 'city' ) . '.mmdb';
}

function sm_asn_is_ready() {
	return is_readable( sm_geo_file( 'asn' ) );
}

/**
 * Opérateur réseau d'une IP (base DB-IP « ASN Lite ») : [numéro, nom]. Vide si inconnu.
 */
function sm_asn_lookup( $ip ) {
	if ( ! $ip || ! sm_asn_is_ready() || ! filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE ) ) {
		return array( 0, '' );
	}
	try {
		$db  = new StatsM_Mmdb( sm_geo_file( 'asn' ) );
		$rec = $db->get( $ip );
		$db->close();
	} catch ( Throwable $e ) {
		return array( 0, '' );
	}
	return array( (int) ( $rec['autonomous_system_number'] ?? 0 ), (string) ( $rec['autonomous_system_organization'] ?? '' ) );
}

function sm_geo_is_ready() {
	return is_readable( sm_geo_file() );
}

/**
 * Retourne [code pays, ville, latitude, longitude] pour une IP. Chaînes vides si inconnu.
 */
function sm_geo_lookup( $ip ) {
	// Certains hébergeurs / CDN fournissent déjà la localisation (Cloudflare, CloudFront…).
	$country = strtoupper( substr( (string) ( $_SERVER['HTTP_CF_IPCOUNTRY'] ?? $_SERVER['HTTP_CLOUDFRONT_VIEWER_COUNTRY'] ?? '' ), 0, 2 ) );
	$city    = (string) ( $_SERVER['HTTP_CF_IPCITY'] ?? $_SERVER['HTTP_CLOUDFRONT_VIEWER_CITY'] ?? '' );
	if ( 'XX' === $country || 'T1' === $country ) {
		$country = '';
	}
	if ( $city && $country ) {
		return array( $country, sm_clean_text( rawurldecode( $city ), 100 ), null, null );
	}
	if ( ! $ip || ! sm_geo_is_ready() || ! filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE ) ) {
		return array( $country, '', null, null );
	}
	try {
		$db  = new StatsM_Mmdb( sm_geo_file() );
		$rec = $db->get( $ip );
		$db->close();
	} catch ( Throwable $e ) {
		return array( $country, '', null, null );
	}
	if ( ! is_array( $rec ) ) {
		return array( $country, '', null, null );
	}
	$names = $rec['city']['names'] ?? array();
	$city  = $names['fr'] ?? $names['en'] ?? '';
	$cc    = strtoupper( (string) ( $rec['country']['iso_code'] ?? $country ) );
	// Coordonnées du centre de la ville (arrondies : jamais plus précises que la commune).
	$lat = isset( $rec['location']['latitude'] ) ? round( (float) $rec['location']['latitude'], 2 ) : null;
	$lon = isset( $rec['location']['longitude'] ) ? round( (float) $rec['location']['longitude'], 2 ) : null;
	return array( substr( $cc, 0, 2 ), mb_substr( (string) $city, 0, 100 ), $lat, $lon );
}

/* -------------------------------------------------------------------------
 * Position donnée par le navigateur (GPS / Wi-Fi) -> commune
 * ---------------------------------------------------------------------- */

/** Coordonnées valides : [lat, lon, précision en m], ou null. */
function sm_gps_clean( $g ) {
	if ( ! is_array( $g ) ) {
		return null;
	}
	$la = isset( $g['la'] ) && is_numeric( $g['la'] ) ? (float) $g['la'] : null;
	$lo = isset( $g['lo'] ) && is_numeric( $g['lo'] ) ? (float) $g['lo'] : null;
	if ( null === $la || null === $lo || abs( $la ) > 90 || abs( $lo ) > 180 || ( 0.0 === $la && 0.0 === $lo ) ) {
		return null;
	}
	$ac = isset( $g['ac'] ) && is_numeric( $g['ac'] ) ? (int) $g['ac'] : 0;
	return array( round( $la, 5 ), round( $lo, 5 ), max( 0, min( 100000, $ac ) ) );
}

/** Lecture JSON d'un service de géocodage (délai court : la réponse au visiteur ne doit pas traîner). */
function sm_http_json( $url ) {
	$ua = 'RandothequeStats/' . SM_VERSION;
	if ( function_exists( 'curl_init' ) ) {
		$ch = curl_init( $url );
		curl_setopt_array(
			$ch,
			array(
				CURLOPT_RETURNTRANSFER => true,
				CURLOPT_FOLLOWLOCATION => true,
				CURLOPT_USERAGENT      => $ua,
				CURLOPT_CONNECTTIMEOUT => 3,
				CURLOPT_TIMEOUT        => 5,
				CURLOPT_HTTPHEADER     => array( 'Accept: application/json', 'Accept-Language: fr' ),
			)
		);
		$body = curl_exec( $ch );
		$code = (int) curl_getinfo( $ch, CURLINFO_HTTP_CODE );
		curl_close( $ch );
	} else {
		$ctx  = stream_context_create( array( 'http' => array( 'header' => "User-Agent: $ua\r\nAccept-Language: fr\r\n", 'timeout' => 5, 'ignore_errors' => true ) ) );
		$body = @file_get_contents( $url, false, $ctx );
		$code = $body ? 200 : 0;
	}
	$data = 200 === $code ? json_decode( (string) $body, true ) : null;
	return is_array( $data ) ? $data : null;
}

/**
 * Commune (et quartier / arrondissement quand il existe) d'un point : [code pays, nom].
 * France : Géoplateforme de l'IGN (adresses BAN). Ailleurs : Nominatim (OpenStreetMap).
 * Résultat gardé en cache par carré d'environ 100 m.
 */
function sm_reverse_geocode( $lat, $lon ) {
	$key = sprintf( '%.3f,%.3f', $lat, $lon );
	$hit = sm_q( 'SELECT cc, city FROM geocache WHERE k = ?', array( $key ) )->fetch();
	if ( $hit ) {
		return array( $hit['cc'], $hit['city'] );
	}
	$cc   = '';
	$city = '';
	$ign  = sm_http_json( 'https://data.geopf.fr/geocodage/reverse?' . http_build_query( array( 'lat' => $lat, 'lon' => $lon, 'index' => 'address', 'limit' => 1 ) ) );
	$p    = $ign['features'][0]['properties'] ?? null;
	// La BAN répond aussi près des frontières : on n'accepte que les adresses à moins de 2 km.
	if ( is_array( $p ) && ! empty( $p['city'] ) && ( ! isset( $p['distance'] ) || $p['distance'] < 2000 ) ) {
		$cc   = 'FR';
		$city = (string) $p['city'];
		if ( ! empty( $p['district'] ) && false === stripos( (string) $p['district'], 'arrondissement' ) ) {
			$city .= ' (' . $p['district'] . ')';
		} elseif ( ! empty( $p['district'] ) ) {
			$city = (string) $p['district']; // « Lyon 9e Arrondissement »
		}
		// Outre-mer : code pays d'après le code postal.
		$dom = array( '971' => 'GP', '972' => 'MQ', '973' => 'GF', '974' => 'RE', '975' => 'PM', '976' => 'YT' );
		$cp  = substr( (string) ( $p['postcode'] ?? '' ), 0, 3 );
		if ( isset( $dom[ $cp ] ) ) {
			$cc = $dom[ $cp ];
		}
	} else {
		$osm = sm_http_json( 'https://nominatim.openstreetmap.org/reverse?' . http_build_query( array( 'format' => 'jsonv2', 'lat' => $lat, 'lon' => $lon, 'zoom' => 14, 'accept-language' => 'fr' ) ) );
		$a   = $osm['address'] ?? null;
		if ( is_array( $a ) ) {
			$cc   = strtoupper( (string) ( $a['country_code'] ?? '' ) );
			$city = (string) ( $a['city'] ?? $a['town'] ?? $a['village'] ?? $a['municipality'] ?? $a['hamlet'] ?? $a['county'] ?? '' );
			$sub  = (string) ( $a['suburb'] ?? $a['city_district'] ?? '' );
			if ( $city && $sub && $sub !== $city ) {
				$city .= ' (' . $sub . ')';
			}
		}
	}
	$cc   = substr( preg_replace( '/[^A-Z]/', '', $cc ), 0, 2 );
	$city = sm_clean_text( $city, 100 );
	if ( '' !== $city ) {
		sm_q( 'INSERT OR REPLACE INTO geocache (k, cc, city, ts) VALUES (?, ?, ?, ?)', array( $key, $cc, $city, time() ) );
	}
	return array( $cc, $city );
}

/* -------------------------------------------------------------------------
 * Téléchargement de la base des villes, par étapes courtes
 *
 * La base fait ~60 Mo compressée. Pour ne jamais dépasser le temps maximal d'une
 * requête (PHP, hébergeur, ou Cloudflare qui coupe à 100 s), elle est récupérée
 * par morceaux de 16 Mo, chacun dans sa propre requête :
 *   sm_geo_step('debut')  trouve le fichier du mois et sa taille
 *   sm_geo_step('suite')  télécharge le morceau suivant (à répéter)
 *   sm_geo_step('fin')    décompresse, vérifie et met la base en service
 * Chaque étape renvoie un tableau (progression) ou un message d'erreur (string).
 * ---------------------------------------------------------------------- */

define( 'SM_GEO_CHUNK', 16 * 1024 * 1024 );

/**
 * Requête HTTP vers DB-IP ou MaxMind. $out : fichier où écrire le corps (null = en-têtes seuls).
 * $auth : « identifiant:clé » (MaxMind), envoyé seulement au premier serveur, pas après redirection.
 *
 * @return array [code HTTP, taille annoncée, message d'erreur, adresse finale, taille totale (Content-Range)]
 */
function sm_geo_http( $url, $out = null, $range = '', $auth = '' ) {
	$ua = 'RandothequeStats/' . SM_VERSION;
	if ( function_exists( 'curl_init' ) ) {
		$total = 0;
		$ch    = curl_init( $url );
		curl_setopt_array(
			$ch,
			array(
				CURLOPT_FOLLOWLOCATION => true,
				CURLOPT_USERAGENT      => $ua,
				CURLOPT_CONNECTTIMEOUT => 15,
				CURLOPT_TIMEOUT        => 75,
				CURLOPT_HEADERFUNCTION => function ( $c, $h ) use ( &$total ) {
					if ( preg_match( '~^Content-Range:\s*bytes\s+\d+-\d+/(\d+)~i', $h, $m ) ) {
						$total = (int) $m[1];
					}
					return strlen( $h );
				},
			)
		);
		if ( $auth ) {
			curl_setopt( $ch, CURLOPT_USERPWD, $auth );
		}
		if ( $out ) {
			curl_setopt( $ch, CURLOPT_FILE, $out );
		} else {
			curl_setopt( $ch, CURLOPT_NOBODY, true );
			curl_setopt( $ch, CURLOPT_RETURNTRANSFER, true );
		}
		if ( $range ) {
			curl_setopt( $ch, CURLOPT_RANGE, $range );
		}
		$ok   = curl_exec( $ch );
		$code = (int) curl_getinfo( $ch, CURLINFO_HTTP_CODE );
		$len  = (int) curl_getinfo( $ch, CURLINFO_CONTENT_LENGTH_DOWNLOAD );
		$err  = $ok ? '' : curl_error( $ch );
		$eff  = (string) curl_getinfo( $ch, CURLINFO_EFFECTIVE_URL );
		curl_close( $ch );
		return array( $code, $len, $err, $eff, $total );
	}
	if ( $auth ) {
		return array( 0, 0, 'cURL est nécessaire pour télécharger chez MaxMind', '', 0 );
	}
	// Sans cURL : flux PHP (nécessite allow_url_fopen).
	$headers = "User-Agent: $ua\r\n" . ( $range ? "Range: bytes=$range\r\n" : '' );
	$ctx     = stream_context_create( array( 'http' => array( 'method' => $out ? 'GET' : 'HEAD', 'header' => $headers, 'timeout' => 75, 'ignore_errors' => true ) ) );
	$in      = @fopen( $url, 'rb', false, $ctx );
	if ( ! $in ) {
		return array( 0, 0, 'connexion impossible (cURL absent et allow_url_fopen désactivé ?)', $url, 0 );
	}
	$meta = stream_get_meta_data( $in );
	$code = 0;
	$len  = 0;
	foreach ( (array) ( $meta['wrapper_data'] ?? array() ) as $h ) {
		if ( preg_match( '~^HTTP/\S+\s+(\d+)~', $h, $m ) ) {
			$code = (int) $m[1];
		} elseif ( preg_match( '~^Content-Length:\s*(\d+)~i', $h, $m ) ) {
			$len = (int) $m[1];
		}
	}
	if ( $out ) {
		stream_copy_to_stream( $in, $out );
	}
	fclose( $in );
	return array( $code, $len, '', $url, 0 );
}

/** Identifiants MaxMind « compte:clé » si renseignés (secret.php), sinon chaîne vide. */
function sm_maxmind_auth() {
	$id  = trim( (string) sm_cfg( 'maxmind_account_id' ) );
	$key = trim( (string) sm_cfg( 'maxmind_license_key' ) );
	return ( '' !== $id && '' !== $key ) ? $id . ':' . $key : '';
}

/**
 * Début du téléchargement chez MaxMind (GeoLite2 City, archive .tar.gz).
 * L'adresse de MaxMind redirige vers un lien temporaire signé : on le retient pour que les
 * morceaux suivants n'utilisent qu'un seul des 30 téléchargements quotidiens du compte.
 */
function sm_geo_maxmind_start( $gz, $key ) {
	$url = 'https://download.maxmind.com/geoip/databases/GeoLite2-City/download?suffix=tar.gz';
	$tmp = fopen( 'php://temp', 'w+b' );
	list( $code, , $err, $eff, $total ) = sm_geo_http( $url, $tmp, '0-0', sm_maxmind_auth() );
	fclose( $tmp );
	if ( 401 === $code ) {
		return 'MaxMind refuse les identifiants (numéro de compte ou clé de licence incorrects)';
	}
	if ( 206 !== $code || $total <= 0 || '' === $eff ) {
		return 'le site MaxMind ne répond pas au serveur (' . ( $err ? $err : "réponse HTTP $code" ) . ')';
	}
	@unlink( $gz );
	if ( false === @file_put_contents( $gz, '' ) ) {
		return 'impossible de créer le fichier dans data/';
	}
	sm_set( $key, json_encode( array( 'url' => $eff, 'size' => $total, 'src' => 'maxmind' ) ) );
	return array( 'taille' => $total, 'recu' => 0 );
}

/**
 * Extrait le fichier .mmdb d'une archive .tar.gz (lecture en flux, sans tout charger en mémoire).
 *
 * @return true|string
 */
function sm_geo_untar_mmdb( $tgz, $dest ) {
	$in = gzopen( $tgz, 'rb' );
	if ( ! $in ) {
		return 'décompression impossible';
	}
	$read = function ( $n ) use ( $in ) {
		$buf = '';
		while ( strlen( $buf ) < $n && ! gzeof( $in ) ) {
			$part = gzread( $in, min( 1 << 20, $n - strlen( $buf ) ) );
			if ( false === $part || '' === $part ) {
				break;
			}
			$buf .= $part;
		}
		return $buf;
	};
	while ( true ) {
		$head = $read( 512 );
		if ( strlen( $head ) < 512 || '' === trim( $head, "\0" ) ) {
			break;
		}
		$name = rtrim( substr( $head, 0, 100 ), "\0" );
		$size = octdec( trim( substr( $head, 124, 12 ), "\0 " ) );
		$pad  = ( 512 - $size % 512 ) % 512;
		if ( '.mmdb' === substr( $name, -5 ) && in_array( $head[156], array( '0', "\0" ), true ) ) {
			$out = fopen( $dest, 'wb' );
			if ( ! $out ) {
				gzclose( $in );
				return 'décompression impossible';
			}
			$left = $size;
			while ( $left > 0 ) {
				$buf = $read( min( 1 << 20, $left ) );
				if ( '' === $buf || false === fwrite( $out, $buf ) ) {
					fclose( $out );
					gzclose( $in );
					@unlink( $dest );
					return 'décompression interrompue (espace disque plein ?)';
				}
				$left -= strlen( $buf );
			}
			fclose( $out );
			gzclose( $in );
			return true;
		}
		// Autre fichier de l'archive (licence, copyright) : on le saute.
		$skip = $size + $pad;
		while ( $skip > 0 ) {
			$buf = $read( min( 1 << 20, $skip ) );
			if ( '' === $buf ) {
				break 2;
			}
			$skip -= strlen( $buf );
		}
	}
	gzclose( $in );
	return 'aucune base .mmdb dans l\'archive MaxMind';
}

function sm_geo_step( $step, $kind = 'city' ) {
	$kind = 'asn' === $kind ? 'asn' : 'city';
	$key  = 'geo_dl_' . $kind;
	@set_time_limit( 120 );
	$gz = SM_DATA . '/geo-' . $kind . '.mmdb.gz';

	if ( 'debut' === $step ) {
		sm_protect_dir( SM_DATA );
		if ( ! is_writable( SM_DATA ) ) {
			return 'le dossier ' . basename( dirname( SM_DATA ) ) . '/data/ n\'est pas accessible en écriture sur le serveur';
		}
		// Villes : GeoLite2 City de MaxMind si un compte est renseigné (plus précis en France).
		if ( 'city' === $kind && sm_maxmind_auth() ) {
			return sm_geo_maxmind_start( $gz, $key );
		}
		$last = '';
		foreach ( array( 0, 1 ) as $back ) {
			$url = 'https://download.db-ip.com/free/dbip-' . $kind . '-lite-' . date( 'Y-m', strtotime( "first day of -$back month" ) ) . '.mmdb.gz';
			list( $code, $len, $err ) = sm_geo_http( $url );
			if ( 200 === $code && $len > 0 ) {
				@unlink( $gz );
				if ( false === @file_put_contents( $gz, '' ) ) {
					return 'impossible de créer le fichier dans data/';
				}
				sm_set( $key, json_encode( array( 'url' => $url, 'size' => $len, 'src' => 'dbip' ) ) );
				return array( 'taille' => $len, 'recu' => 0 );
			}
			$last = $err ? $err : "réponse HTTP $code";
		}
		return 'le site DB-IP ne répond pas au serveur (' . $last . ')';
	}

	$state = json_decode( (string) sm_get( $key, '' ), true );
	if ( ! is_array( $state ) || ! is_file( $gz ) ) {
		return 'téléchargement non commencé, relancez l\'installation';
	}
	$size = (int) $state['size'];
	clearstatcache( true, $gz );
	$have = (int) filesize( $gz );

	if ( 'suite' === $step ) {
		if ( $have < $size ) {
			$end = min( $have + SM_GEO_CHUNK, $size ) - 1;
			$out = fopen( $gz, 'ab' );
			list( $code, , $err ) = sm_geo_http( $state['url'], $out, "$have-$end" );
			fclose( $out );
			clearstatcache( true, $gz );
			$now = (int) filesize( $gz );
			if ( 206 !== $code || $now !== $end + 1 ) {
				// Morceau incomplet : on le retire pour pouvoir réessayer proprement.
				$h = fopen( $gz, 'r+' );
				ftruncate( $h, $have );
				fclose( $h );
				// Le lien signé de MaxMind expire au bout de quelques heures.
				$again = ( 'maxmind' === ( $state['src'] ?? '' ) && in_array( $code, array( 400, 403 ), true ) ) ? 'lien expiré, relancez la mise à jour' : 'réessayez';
				return 'morceau non reçu (' . ( $err ? $err : "réponse HTTP $code" ) . '), ' . $again;
			}
			$have = $now;
		}
		return array( 'taille' => $size, 'recu' => $have );
	}

	if ( 'fin' === $step ) {
		if ( $have !== $size ) {
			return 'téléchargement incomplet, relancez l\'installation';
		}
		$part = sm_geo_file( $kind ) . '.part';
		$src  = (string) ( $state['src'] ?? 'dbip' );
		if ( 'maxmind' === $src ) {
			$r = sm_geo_untar_mmdb( $gz, $part );
			if ( true !== $r ) {
				return $r;
			}
		} else {
			$in   = gzopen( $gz, 'rb' );
			$out  = fopen( $part, 'wb' );
			if ( ! $in || ! $out ) {
				return 'décompression impossible';
			}
			while ( ! gzeof( $in ) ) {
				$buf = gzread( $in, 1 << 20 );
				if ( false === $buf || false === fwrite( $out, $buf ) ) {
					gzclose( $in );
					fclose( $out );
					@unlink( $part );
					return 'décompression interrompue (espace disque plein ?)';
				}
			}
			gzclose( $in );
			fclose( $out );
		}
		@unlink( $gz );
		sm_set( $key, '' );
		try {
			( new StatsM_Mmdb( $part ) )->close();
		} catch ( Throwable $e ) {
			@unlink( $part );
			return 'le fichier téléchargé est invalide';
		}
		if ( ! @rename( $part, sm_geo_file( $kind ) ) ) {
			@unlink( $part );
			return 'impossible de mettre la base en service';
		}
		sm_set( 'geo_src_' . $kind, $src );
		return array( 'ok' => true );
	}

	return 'étape inconnue';
}

/**
 * Téléchargement complet en une fois (page de réglages de l'outil autonome).
 *
 * @return true|string  true, ou le message d'erreur.
 */
function sm_geo_download() {
	@set_time_limit( 900 );
	$r = sm_geo_step( 'debut' );
	while ( is_array( $r ) && $r['recu'] < $r['taille'] ) {
		$r = sm_geo_step( 'suite' );
	}
	if ( is_array( $r ) ) {
		$r = sm_geo_step( 'fin' );
	}
	return is_array( $r ) ? true : $r;
}

/**
 * Lecteur minimal du format MaxMind DB (.mmdb), sans dépendance.
 * Spécification : https://maxmind.github.io/MaxMind-DB/
 */
class StatsM_Mmdb {
	private $fh;
	private $node_count;
	private $record_size;
	private $ip_version;
	private $data_start;
	private $ipv4_start = null;

	public function __construct( $file ) {
		$this->fh = @fopen( $file, 'rb' );
		if ( ! $this->fh ) {
			throw new RuntimeException( 'mmdb: fichier illisible' );
		}
		$size  = filesize( $file );
		$chunk = min( $size, 128 * 1024 );
		fseek( $this->fh, $size - $chunk );
		$tail = fread( $this->fh, $chunk );
		$pos  = strrpos( $tail, "\xAB\xCD\xEFMaxMind.com" );
		if ( false === $pos ) {
			throw new RuntimeException( 'mmdb: métadonnées introuvables' );
		}
		$meta_start = $size - $chunk + $pos + 14;
		list( $meta ) = $this->decode( $meta_start, 0 );

		$this->node_count  = (int) $meta['node_count'];
		$this->record_size = (int) $meta['record_size'];
		$this->ip_version  = (int) $meta['ip_version'];
		if ( ! in_array( $this->record_size, array( 24, 28, 32 ), true ) ) {
			throw new RuntimeException( 'mmdb: taille d\'enregistrement inconnue' );
		}
		$this->data_start = (int) ( $this->node_count * $this->record_size / 4 ) + 16;
	}

	public function close() {
		if ( $this->fh ) {
			fclose( $this->fh );
			$this->fh = null;
		}
	}

	public function get( $ip ) {
		$packed = @inet_pton( $ip );
		if ( false === $packed ) {
			return null;
		}
		$bits = strlen( $packed ) * 8;
		if ( 4 === $this->ip_version && 128 === $bits ) {
			return null;
		}
		$node = ( 6 === $this->ip_version && 32 === $bits ) ? $this->ipv4_start() : 0;
		for ( $i = 0; $i < $bits && $node < $this->node_count; $i++ ) {
			$bit  = ( ord( $packed[ $i >> 3 ] ) >> ( 7 - ( $i & 7 ) ) ) & 1;
			$node = $this->read_node( $node, $bit );
		}
		if ( $node <= $this->node_count ) {
			return null;
		}
		$offset = $node - $this->node_count - 16;
		list( $value ) = $this->decode( $this->data_start, $offset );
		return $value;
	}

	private function ipv4_start() {
		if ( null === $this->ipv4_start ) {
			$node = 0;
			for ( $i = 0; $i < 96 && $node < $this->node_count; $i++ ) {
				$node = $this->read_node( $node, 0 );
			}
			$this->ipv4_start = $node;
		}
		return $this->ipv4_start;
	}

	private function read( $offset, $len ) {
		if ( 0 === $len ) {
			return '';
		}
		fseek( $this->fh, $offset );
		$buf = fread( $this->fh, $len );
		if ( false === $buf || strlen( $buf ) !== $len ) {
			throw new RuntimeException( 'mmdb: lecture hors limites' );
		}
		return $buf;
	}

	private function read_node( $node, $index ) {
		switch ( $this->record_size ) {
			case 24:
				$b = $this->read( $node * 6 + $index * 3, 3 );
				return unpack( 'N', "\0" . $b )[1];
			case 28:
				$b = $this->read( $node * 7, 7 );
				if ( 0 === $index ) {
					return ( ( ord( $b[3] ) & 0xF0 ) << 20 ) | unpack( 'N', "\0" . substr( $b, 0, 3 ) )[1];
				}
				return ( ( ord( $b[3] ) & 0x0F ) << 24 ) | unpack( 'N', "\0" . substr( $b, 4, 3 ) )[1];
			default:
				return unpack( 'N', $this->read( $node * 8 + $index * 4, 4 ) )[1];
		}
	}

	private function uint( $bytes ) {
		$v = 0;
		$n = strlen( $bytes );
		for ( $i = 0; $i < $n; $i++ ) {
			$v = $v * 256 + ord( $bytes[ $i ] );
		}
		return $v;
	}

	/**
	 * Décode une valeur. $base = début de la section, $off = position relative.
	 * Retourne [valeur, position suivante].
	 */
	private function decode( $base, $off ) {
		$ctrl = ord( $this->read( $base + $off, 1 ) );
		$off++;
		$type = $ctrl >> 5;

		if ( 1 === $type ) { // Pointeur.
			$psize = ( $ctrl >> 3 ) & 3;
			$v     = $ctrl & 7;
			$b     = $this->read( $base + $off, $psize + 1 );
			$off  += $psize + 1;
			switch ( $psize ) {
				case 0:
					$ptr = ( $v << 8 ) | ord( $b );
					break;
				case 1:
					$ptr = ( ( $v << 16 ) | $this->uint( $b ) ) + 2048;
					break;
				case 2:
					$ptr = ( ( $v << 24 ) | $this->uint( $b ) ) + 526336;
					break;
				default:
					$ptr = $this->uint( $b );
			}
			list( $value ) = $this->decode( $base, $ptr );
			return array( $value, $off );
		}

		if ( 0 === $type ) { // Type étendu.
			$type = 7 + ord( $this->read( $base + $off, 1 ) );
			$off++;
		}

		$size = $ctrl & 0x1f;
		if ( $size >= 29 ) {
			$extra = $size - 28;
			$n     = $this->uint( $this->read( $base + $off, $extra ) );
			$off  += $extra;
			$size  = array( 1 => 29, 2 => 285, 3 => 65821 )[ $extra ] + $n;
		}

		switch ( $type ) {
			case 2: // Texte UTF-8.
			case 4: // Octets.
				return array( $this->read( $base + $off, $size ), $off + $size );
			case 3: // Double.
				return array( unpack( 'E', $this->read( $base + $off, 8 ) )[1], $off + 8 );
			case 15: // Float.
				return array( unpack( 'G', $this->read( $base + $off, 4 ) )[1], $off + 4 );
			case 5:  // uint16.
			case 6:  // uint32.
			case 9:  // uint64.
			case 10: // uint128.
				return array( $this->uint( $this->read( $base + $off, $size ) ), $off + $size );
			case 8: // int32.
				$v = $this->uint( $this->read( $base + $off, $size ) );
				if ( 4 === $size && $v >= 0x80000000 ) {
					$v -= 0x100000000;
				}
				return array( $v, $off + $size );
			case 7: // Map.
				$map = array();
				for ( $i = 0; $i < $size; $i++ ) {
					list( $k, $off ) = $this->decode( $base, $off );
					list( $v, $off ) = $this->decode( $base, $off );
					$map[ $k ]       = $v;
				}
				return array( $map, $off );
			case 11: // Tableau.
				$arr = array();
				for ( $i = 0; $i < $size; $i++ ) {
					list( $arr[], $off ) = $this->decode( $base, $off );
				}
				return array( $arr, $off );
			case 14: // Booléen.
				return array( 0 !== $size, $off );
			default:
				return array( null, $off );
		}
	}
}
