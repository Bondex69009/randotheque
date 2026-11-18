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
		'password_hash'      => '',
	),
	(array) require SM_ROOT . '/config.php',
	// Identifiants privés (dépôt public) : secret.php est écrit au déploiement à partir des
	// secrets GitHub (MAXMIND_ACCOUNT_ID, MAXMIND_LICENSE_KEY), jamais versionné.
	is_readable( SM_ROOT . '/secret.php' ) ? (array) include SM_ROOT . '/secret.php' : array()
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
		CREATE TABLE IF NOT EXISTS admin_ips (k TEXT PRIMARY KEY, seen INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
		CREATE TABLE IF NOT EXISTS login_fails (k TEXT NOT NULL, ts INTEGER NOT NULL);
"
	);
	// Colonnes ajoutées au fil des versions (une base déjà créée en ligne les reçoit ici).
	$have = array_column( $db->query( 'PRAGMA table_info(hits)' )->fetchAll(), 'name' );
	$add  = array(
		'browser_v' => "TEXT NOT NULL DEFAULT ''",
		'os_v'      => "TEXT NOT NULL DEFAULT ''",
		'brand'     => "TEXT NOT NULL DEFAULT ''",
		'model'     => "TEXT NOT NULL DEFAULT ''",
		'res'       => "TEXT NOT NULL DEFAULT ''",
		'dpr'       => "TEXT NOT NULL DEFAULT ''",
		'net'       => "TEXT NOT NULL DEFAULT ''",
		'scroll'    => 'INTEGER NOT NULL DEFAULT 0',
		'btn'       => "TEXT NOT NULL DEFAULT ''",
	);
	foreach ( $add as $col => $def ) {
		if ( ! in_array( $col, $have, true ) ) {
			$db->exec( "ALTER TABLE hits ADD COLUMN $col $def" );
		}
	}
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
	sm_q( 'DELETE FROM admin_ips WHERE seen < ?', array( time() - 180 * 86400 ) );
	sm_q( 'DELETE FROM tokens WHERE expires < ?', array( time() ) );
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

/* -------------------------------------------------------------------------
 * CORS : seuls les sites déclarés dans config.php peuvent parler au serveur
 * ---------------------------------------------------------------------- */

function sm_cors() {
	$origin = (string) ( $_SERVER['HTTP_ORIGIN'] ?? '' );
	if ( '' === $origin ) {
		return;
	}
	// Même adresse que le serveur (les deux sites et /stats/ partagent le sous-domaine), ou adresse déclarée.
	$same = strtolower( (string) parse_url( $origin, PHP_URL_HOST ) . ( parse_url( $origin, PHP_URL_PORT ) ? ':' . parse_url( $origin, PHP_URL_PORT ) : '' ) ) === strtolower( (string) ( $_SERVER['HTTP_HOST'] ?? '' ) );
	if ( ! $same && ! in_array( rtrim( $origin, '/' ), (array) sm_cfg( 'allowed_origins' ), true ) ) {
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
 * Espace stats : un champ mot de passe sur la page, puis un jeton (pas de cookie).
 * Seule l'empreinte bcrypt du mot de passe est conservée (config.php : password_hash).
 * ---------------------------------------------------------------------- */

function sm_password_hash() {
	return (string) sm_cfg( 'password_hash' );
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
		return array( 'error' => 'Mot de passe non configuré (config.php : password_hash).', 'code' => 503 );
	}
	if ( ! password_verify( (string) $password, $hash ) ) {
		// L'empreinte des essais ratés ne sert qu'au blocage ; elle ne marque pas l'IP comme admin.
		sm_q( 'INSERT INTO login_fails (k, ts) VALUES (?, ?)', array( $k, time() ) );
		usleep( 400000 );
		return array( 'error' => 'Mot de passe incorrect.', 'code' => 401 );
	}
	$token = bin2hex( random_bytes( 32 ) );
	sm_q( 'INSERT INTO tokens (hash, expires) VALUES (?, ?)', array( hash( 'sha256', $token ), time() + 30 * 86400 ) );
	return array( 'token' => $token );
}

/** Jeton envoyé par la page dans l'en-tête X-Stats-Token (jamais filtré par Apache, contrairement à Authorization). */
function sm_token() {
	$t = (string) ( $_SERVER['HTTP_X_STATS_TOKEN'] ?? '' );
	return preg_match( '/^[a-f0-9]{64}$/i', $t ) ? strtolower( $t ) : '';
}

function sm_logout() {
	$token = sm_token();
	if ( $token ) {
		sm_q( 'DELETE FROM tokens WHERE hash = ?', array( hash( 'sha256', $token ) ) );
	}
}

function sm_require_admin() {
	$token = sm_token();
	if ( ! $token || ! sm_q( 'SELECT 1 FROM tokens WHERE hash = ? AND expires > ?', array( hash( 'sha256', $token ), time() ) )->fetchColumn() ) {
		sm_json( array( 'error' => 'Connectez-vous.', 'login' => true ), 401 );
	}
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
