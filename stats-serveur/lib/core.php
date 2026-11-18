<?php
/**
 * Statistiques des Randothèques : socle (configuration, base SQLite, sécurité).
 *
 * Mesure d'audience sans cookie, conforme aux conditions de la CNIL pour être
 * dispensée de consentement : pas d'adresse IP enregistrée, empreinte anonyme
 * dont la clé change chaque jour, données effacées après 25 mois.
 */

define( 'SM_VERSION', '1.0.0' );
define( 'SM_ROOT', dirname( __DIR__ ) );
define( 'SM_DATA', SM_ROOT . '/data' );

$GLOBALS['sm_config'] = array_merge(
	array(
		'timezone'        => 'Europe/Paris',
		'sites'           => array(),
		'allowed_origins' => array(),
		'session_minutes' => 30,
		'retention'       => 25,
		'allowed_countries'  => array(),
		'datacenter_pattern' => '',
		'proxy_header'       => '',
		'site_host'          => '',
	),
	(array) require SM_ROOT . '/config.php'
);

function sm_cfg( $key ) {
	return $GLOBALS['sm_config'][ $key ] ?? null;
}

date_default_timezone_set( sm_cfg( 'timezone' ) ?: 'Europe/Paris' );

/* -------------------------------------------------------------------------
 * Base de données
 * ---------------------------------------------------------------------- */

function sm_protect_dir( $dir ) {
	if ( ! is_file( $dir . '/.htaccess' ) ) {
		@file_put_contents( $dir . '/.htaccess', "Require all denied\nDeny from all\n" );
	}
	if ( ! is_file( $dir . '/index.html' ) ) {
		@file_put_contents( $dir . '/index.html', '' );
	}
}

function sm_db() {
	static $db = null;
	if ( $db ) {
		return $db;
	}
	if ( ! is_dir( SM_DATA ) ) {
		@mkdir( SM_DATA, 0755, true );
	}
	sm_protect_dir( SM_DATA );

	$db = new PDO( 'sqlite:' . SM_DATA . '/stats.sqlite' );
	$db->setAttribute( PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION );
	$db->setAttribute( PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC );
	$db->exec( 'PRAGMA busy_timeout = 5000' );
	$db->exec( 'PRAGMA journal_mode = WAL' );
	$db->exec( 'PRAGMA synchronous = NORMAL' );

	// Une ligne = une page vue (type 1), une action (type 2) ou un affichage du compteur sur le blog (type 3).
	// Aucune adresse IP ni identifiant durable n'est enregistré.
	$db->exec(
		"CREATE TABLE IF NOT EXISTS hits (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			site TEXT NOT NULL,
			ts TEXT NOT NULL,
			day TEXT NOT NULL,
			visitor TEXT NOT NULL DEFAULT '',
			session TEXT NOT NULL DEFAULT '',
			ipk TEXT NOT NULL DEFAULT '',
			type INTEGER NOT NULL DEFAULT 1,
			is_entry INTEGER NOT NULL DEFAULT 0,
			landing TEXT NOT NULL DEFAULT '',
			event TEXT NOT NULL DEFAULT '',
			label TEXT NOT NULL DEFAULT '',
			ref TEXT NOT NULL DEFAULT '',
			src_type TEXT NOT NULL DEFAULT '',
			src_name TEXT NOT NULL DEFAULT '',
			campaign TEXT NOT NULL DEFAULT '',
			device TEXT NOT NULL DEFAULT '',
			browser TEXT NOT NULL DEFAULT '',
			os TEXT NOT NULL DEFAULT '',
			country TEXT NOT NULL DEFAULT '',
			city TEXT NOT NULL DEFAULT '',
			lat REAL,
			lon REAL,
			lang TEXT NOT NULL DEFAULT '',
			screen TEXT NOT NULL DEFAULT '',
			theme TEXT NOT NULL DEFAULT '',
			app INTEGER NOT NULL DEFAULT 0,
			duration INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS hits_site_ts ON hits (site, ts);
		CREATE INDEX IF NOT EXISTS hits_visitor ON hits (visitor, id);
		CREATE INDEX IF NOT EXISTS hits_session ON hits (session);
		CREATE INDEX IF NOT EXISTS hits_ipk ON hits (ipk, day);
		CREATE TABLE IF NOT EXISTS rejects (day TEXT NOT NULL, site TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, site, reason, detail));
		CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS admin_ips (k TEXT PRIMARY KEY, seen INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS login_fails (k TEXT NOT NULL, ts INTEGER NOT NULL);"
	);
	return $db;
}

function sm_q( $sql, array $params = array() ) {
	$st = sm_db()->prepare( $sql );
	$st->execute( $params );
	return $st;
}

function sm_get( $key, $default = null ) {
	$v = sm_q( 'SELECT v FROM settings WHERE k = ?', array( $key ) )->fetchColumn();
	return false === $v ? $default : $v;
}

function sm_set( $key, $value ) {
	sm_q( 'INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)', array( $key, (string) $value ) );
}

/**
 * Clé secrète permanente du serveur (signatures, empreinte des IP de l'administrateur).
 */
function sm_secret() {
	$key = sm_get( 'secret' );
	if ( ! $key ) {
		$key = bin2hex( random_bytes( 32 ) );
		sm_set( 'secret', $key );
	}
	return $key;
}

/**
 * Sel aléatoire renouvelé chaque jour puis oublié : un visiteur ne peut
 * pas être reconnu d'un jour à l'autre, la mesure reste anonyme.
 */
function sm_salt() {
	$today = date( 'Y-m-d' );
	$salt  = json_decode( (string) sm_get( 'salt', '' ), true );
	if ( ! is_array( $salt ) || ( $salt['d'] ?? '' ) !== $today ) {
		$salt = array(
			'd' => $today,
			's' => bin2hex( random_bytes( 16 ) ),
		);
		sm_set( 'salt', json_encode( $salt ) );
	}
	return $salt['s'];
}

/**
 * Entretien quotidien : effacement des données trop anciennes.
 */
function sm_daily_maintenance() {
	$today = date( 'Y-m-d' );
	if ( sm_get( 'maintenance' ) === $today ) {
		return;
	}
	sm_set( 'maintenance', $today );
	$months = max( 1, min( 25, (int) sm_cfg( 'retention' ) ) );
	sm_q( 'DELETE FROM hits WHERE ts < ?', array( date( 'Y-m-d 00:00:00', strtotime( "-$months months" ) ) ) );
	sm_q( 'DELETE FROM tokens WHERE expires < ?', array( time() ) );
	sm_q( 'DELETE FROM admin_ips WHERE seen < ?', array( time() - 180 * 86400 ) );
	sm_q( 'DELETE FROM login_fails WHERE ts < ?', array( time() - 86400 ) );
	sm_q( 'DELETE FROM rejects WHERE day < ?', array( date( 'Y-m-d', strtotime( "-$months months" ) ) ) );
}

/* -------------------------------------------------------------------------
 * Outils
 * ---------------------------------------------------------------------- */

function sm_clean_text( $s, $max = 255 ) {
	$s = strip_tags( (string) $s );
	$s = preg_replace( '/[\x00-\x1F\x7F]+/u', ' ', $s );
	$s = trim( preg_replace( '/\s+/u', ' ', (string) $s ) );
	return mb_substr( $s, 0, $max );
}

function sm_json( $data, $code = 200 ) {
	http_response_code( $code );
	header( 'Content-Type: application/json; charset=utf-8' );
	header( 'Cache-Control: no-store' );
	echo json_encode( $data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
	exit;
}

function sm_done( $code = 204 ) {
	http_response_code( $code );
	exit;
}

/**
 * Adresse IP du visiteur (utilisée en mémoire seulement, jamais enregistrée).
 */
function sm_ip() {
	// Seule l'adresse vue par le serveur fait foi : les en-têtes X-Forwarded-For & co. se falsifient
	// en une ligne (un robot pourrait se faire passer pour un visiteur français ou pour l'admin).
	// Derrière un proxy (Cloudflare en nuage orange), indiquer son en-tête dans config.php : proxy_header.
	$keys = array_filter( array( (string) sm_cfg( 'proxy_header' ), 'REMOTE_ADDR' ) );
	foreach ( $keys as $key ) {
		if ( empty( $_SERVER[ $key ] ) ) {
			continue;
		}
		foreach ( explode( ',', (string) $_SERVER[ $key ] ) as $ip ) {
			$ip = trim( $ip );
			if ( filter_var( $ip, FILTER_VALIDATE_IP ) ) {
				return $ip;
			}
		}
	}
	return '';
}

/**
 * Réseau de l'adresse : l'IPv6 d'une box change souvent ses derniers blocs,
 * on garde le préfixe /64 (le foyer) pour reconnaître l'administrateur.
 */
function sm_ip_net( $ip ) {
	if ( false !== strpos( $ip, ':' ) ) {
		$bin = @inet_pton( $ip );
		return $bin ? bin2hex( substr( $bin, 0, 8 ) ) : $ip;
	}
	return $ip;
}

/** Empreinte permanente (clé secrète) : sert seulement à reconnaître l'IP de l'administrateur. */
function sm_admin_key( $ip ) {
	return substr( hash_hmac( 'sha256', 'admin|' . sm_ip_net( $ip ), sm_secret() ), 0, 24 );
}

/** Empreinte anonyme du jour d'une IP (le sel change chaque jour). */
function sm_ip_day_key( $ip ) {
	return substr( hash( 'sha256', sm_salt() . '|ip|' . sm_ip_net( $ip ) ), 0, 16 );
}

function sm_is_admin_ip( $ip ) {
	return (bool) sm_q( 'SELECT 1 FROM admin_ips WHERE k = ?', array( sm_admin_key( $ip ) ) )->fetchColumn();
}

/**
 * Note l'adresse de l'administrateur connecté : ses visites ne sont plus comptées,
 * et celles du jour depuis cette adresse sont retirées.
 */
function sm_remember_admin_ip() {
	$ip = sm_ip();
	if ( ! $ip ) {
		return;
	}
	sm_q( 'INSERT OR REPLACE INTO admin_ips (k, seen) VALUES (?, ?)', array( sm_admin_key( $ip ), time() ) );
	sm_q( 'DELETE FROM hits WHERE ipk = ? AND day = ?', array( sm_ip_day_key( $ip ), date( 'Y-m-d' ) ) );
}

/* -------------------------------------------------------------------------
 * CORS : seuls les sites déclarés dans config.php peuvent parler au serveur
 * ---------------------------------------------------------------------- */

function sm_cors() {
	$origin = (string) ( $_SERVER['HTTP_ORIGIN'] ?? '' );
	if ( '' === $origin ) {
		return;
	}
	if ( ! in_array( rtrim( $origin, '/' ), (array) sm_cfg( 'allowed_origins' ), true ) ) {
		sm_done( 403 );
	}
	header( 'Access-Control-Allow-Origin: ' . $origin );
	header( 'Vary: Origin' );
	if ( 'OPTIONS' === ( $_SERVER['REQUEST_METHOD'] ?? '' ) ) {
		header( 'Access-Control-Allow-Methods: GET, POST' );
		header( 'Access-Control-Allow-Headers: Content-Type, Authorization' );
		header( 'Access-Control-Max-Age: 86400' );
		sm_done();
	}
}

/* -------------------------------------------------------------------------
 * Connexion de l'administrateur (jeton, pas de cookie)
 * ---------------------------------------------------------------------- */

function sm_password_hash() {
	$file = SM_ROOT . '/secret.php';
	if ( ! is_file( $file ) ) {
		return '';
	}
	$secret = (array) require $file;
	return (string) ( $secret['password_hash'] ?? '' );
}

function sm_login( $password ) {
	$ip   = sm_ip();
	$k    = sm_admin_key( $ip );
	$fail = (int) sm_q( 'SELECT COUNT(*) FROM login_fails WHERE k = ? AND ts > ?', array( $k, time() - 900 ) )->fetchColumn();
	if ( $fail >= 8 ) {
		return array( 'error' => 'Trop d\'essais. Réessayez dans un quart d\'heure.', 'code' => 429 );
	}
	$hash = sm_password_hash();
	if ( '' === $hash ) {
		return array( 'error' => 'Mot de passe non configuré sur le serveur (secret.php).', 'code' => 500 );
	}
	if ( ! password_verify( (string) $password, $hash ) ) {
		// L'empreinte des essais ratés ne sert qu'au blocage ; elle ne marque pas l'IP comme admin.
		sm_q( 'INSERT INTO login_fails (k, ts) VALUES (?, ?)', array( $k, time() ) );
		usleep( 400000 );
		return array( 'error' => 'Mot de passe incorrect.', 'code' => 401 );
	}
	$token = bin2hex( random_bytes( 32 ) );
	sm_q( 'INSERT INTO tokens (hash, expires) VALUES (?, ?)', array( hash( 'sha256', $token ), time() + 30 * 86400 ) );
	sm_remember_admin_ip();
	return array( 'token' => $token );
}

function sm_bearer() {
	$h = (string) ( $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '' );
	if ( '' === $h && function_exists( 'getallheaders' ) ) {
		foreach ( getallheaders() as $name => $value ) {
			if ( 'authorization' === strtolower( $name ) ) {
				$h = (string) $value;
			}
		}
	}
	return preg_match( '/^Bearer\s+([a-f0-9]{64})$/i', $h, $m ) ? strtolower( $m[1] ) : '';
}

function sm_require_admin() {
	$token = sm_bearer();
	if ( ! $token || ! sm_q( 'SELECT 1 FROM tokens WHERE hash = ? AND expires > ?', array( hash( 'sha256', $token ), time() ) )->fetchColumn() ) {
		sm_json( array( 'error' => 'Session expirée, reconnectez-vous.' ), 401 );
	}
	// L'administrateur peut changer d'adresse (4G, autre wifi) : on la note à chaque ouverture.
	sm_remember_admin_ip();
	return $token;
}

/**
 * Compte une visite écartée (total par jour, raison et pays / hébergeur : aucune donnée personnelle).
 */
function sm_reject( $site, $reason, $detail = '' ) {
	if ( empty( $GLOBALS['sm_count_rejects'] ) ) {
		sm_done();
	}
	try {
		sm_q(
			'INSERT INTO rejects (day, site, reason, detail, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT(day, site, reason, detail) DO UPDATE SET n = n + 1',
			array( date( 'Y-m-d' ), $site, $reason, mb_substr( (string) $detail, 0, 80 ) )
		);
	} catch ( Throwable $e ) {
		// Le comptage des rejets ne doit jamais bloquer.
	}
	sm_done();
}
