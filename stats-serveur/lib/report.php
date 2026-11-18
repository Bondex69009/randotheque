<?php
/**
 * Statistiques des Randothèques : calculs du tableau de bord.
 */

/**
 * Bornes de la période demandée : [début, fin (exclue), libellé].
 */
function sm_range( $period, $from = '', $to = '' ) {
	$today = new DateTimeImmutable( 'today' );
	switch ( $period ) {
		case 'today':
			return array( $today, $today->modify( '+1 day' ), 'Aujourd\'hui' );
		case 'yesterday':
			return array( $today->modify( '-1 day' ), $today, 'Hier' );
		case '7d':
			return array( $today->modify( '-6 days' ), $today->modify( '+1 day' ), '7 derniers jours' );
		case '90d':
			return array( $today->modify( '-89 days' ), $today->modify( '+1 day' ), '90 derniers jours' );
		case '12m':
			return array( $today->modify( '-364 days' ), $today->modify( '+1 day' ), '12 derniers mois' );
		case 'all':
			$first = sm_q( 'SELECT MIN(day) FROM hits' )->fetchColumn();
			$start = $first ? new DateTimeImmutable( $first ) : $today;
			return array( $start, $today->modify( '+1 day' ), 'Depuis le début' );
		case 'custom':
			$a = DateTimeImmutable::createFromFormat( '!Y-m-d', $from );
			$b = DateTimeImmutable::createFromFormat( '!Y-m-d', $to );
			if ( $a && $b && $a <= $b ) {
				return array( $a, $b->modify( '+1 day' ), 'Du ' . $a->format( 'd/m/Y' ) . ' au ' . $b->format( 'd/m/Y' ) );
			}
			// Dates invalides : 30 jours.
		default:
			return array( $today->modify( '-29 days' ), $today->modify( '+1 day' ), '30 derniers jours' );
	}
}

function sm_where( $site, DateTimeImmutable $s, DateTimeImmutable $e ) {
	$w = "ts >= '" . $s->format( 'Y-m-d 00:00:00' ) . "' AND ts < '" . $e->format( 'Y-m-d 00:00:00' ) . "'";
	if ( 'all' !== $site ) {
		$w .= ' AND site = ' . sm_db()->quote( $site );
	}
	return $w;
}

function sm_all( $sql ) {
	return sm_q( $sql )->fetchAll();
}

function sm_one( $sql ) {
	return sm_q( $sql )->fetchColumn();
}

/**
 * Indicateurs clés d'une période.
 */
function sm_kpis( $w ) {
	$base = sm_q(
		"SELECT
			COUNT(DISTINCT CASE WHEN type IN (1,2) THEN visitor END) AS visitors,
			COUNT(DISTINCT CASE WHEN type IN (1,2) AND session <> '' THEN session END) AS visits,
			SUM(type = 1) AS pageviews,
			SUM(type = 2) AS actions,
			SUM(type = 2 AND event = 'rando') AS randos,
			SUM(type = 2 AND event = 'gpx') AS gpx,
			SUM(type = 2 AND event IN ('fly','fly_duel')) AS fly,
			SUM(type = 3) AS widget
		FROM hits WHERE $w"
	)->fetch();

	$sess = sm_q(
		"SELECT COUNT(*) AS n,
			SUM(pv = 1 AND ev = 0) AS bounces,
			AVG(dur) AS avg_dur,
			SUM(gpx > 0) AS with_gpx,
			SUM(rando > 0) AS with_rando
		FROM (
			SELECT session, SUM(type = 1) AS pv, SUM(type = 2) AS ev, SUM(duration) AS dur,
				SUM(event = 'gpx') AS gpx, SUM(event = 'rando') AS rando
			FROM hits WHERE $w AND type IN (1,2) AND session <> '' GROUP BY session
		)"
	)->fetch();

	$n = (int) $sess['n'];
	return array(
		'visitors'    => (int) $base['visitors'],
		'visits'      => (int) $base['visits'],
		'pageviews'   => (int) $base['pageviews'],
		'actions'     => (int) $base['actions'],
		'randos'      => (int) $base['randos'],
		'gpx'         => (int) $base['gpx'],
		'fly'         => (int) $base['fly'],
		'widget'      => (int) $base['widget'],
		'avg_dur'     => $n ? (int) round( (float) $sess['avg_dur'] ) : 0,
		'bounce'      => $n ? round( 100 * $sess['bounces'] / $n, 1 ) : 0,
		'per_visit'   => $n ? round( $base['actions'] / $n, 2 ) : 0,
		'gpx_rate'    => $n ? round( 100 * $sess['with_gpx'] / $n, 1 ) : 0,
		'rando_rate'  => $n ? round( 100 * $sess['with_rando'] / $n, 1 ) : 0,
	);
}

/**
 * Courbe d'évolution, par jour, semaine ou mois selon la longueur de la période.
 */
function sm_series( $site, DateTimeImmutable $s, DateTimeImmutable $e ) {
	$days = (int) $s->diff( $e )->days;
	$unit = $days <= 62 ? 'day' : ( $days <= 400 ? 'week' : 'month' );
	$w    = sm_where( $site, $s, $e );

	$rows  = sm_all(
		"SELECT day,
			COUNT(DISTINCT CASE WHEN type IN (1,2) THEN visitor END) AS visitors,
			COUNT(DISTINCT CASE WHEN type IN (1,2) AND session <> '' THEN session END) AS visits,
			SUM(type = 1) AS pageviews,
			SUM(type = 2 AND event = 'rando') AS randos,
			SUM(type = 2 AND event = 'gpx') AS gpx,
			SUM(type = 2) AS actions
		FROM hits WHERE $w GROUP BY day"
	);
	$daily = array();
	foreach ( $rows as $r ) {
		$daily[ $r['day'] ] = $r;
	}

	$months = array( 'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.' );
	$keys   = array( 'visitors', 'visits', 'pageviews', 'randos', 'gpx', 'actions' );
	$out    = array();
	$cur    = $s;
	while ( $cur < $e ) {
		if ( 'day' === $unit ) {
			$next  = $cur->modify( '+1 day' );
			$label = $cur->format( 'j' ) . ' ' . $months[ (int) $cur->format( 'n' ) - 1 ];
		} elseif ( 'week' === $unit ) {
			$next  = $cur->modify( 'monday next week' );
			$label = 'sem. du ' . $cur->format( 'j' ) . ' ' . $months[ (int) $cur->format( 'n' ) - 1 ];
		} else {
			$next  = $cur->modify( 'first day of next month' );
			$label = $months[ (int) $cur->format( 'n' ) - 1 ] . ' ' . $cur->format( 'Y' );
		}
		if ( $next > $e ) {
			$next = $e;
		}
		$point = array(
			'label' => $label,
			'date'  => $cur->format( 'Y-m-d' ),
		);
		foreach ( $keys as $k ) {
			$point[ $k ] = 0;
		}
		for ( $d = $cur; $d < $next; $d = $d->modify( '+1 day' ) ) {
			$row = $daily[ $d->format( 'Y-m-d' ) ] ?? null;
			if ( $row ) {
				foreach ( $keys as $k ) {
					$point[ $k ] += (int) $row[ $k ];
				}
			}
		}
		$out[] = $point;
		$cur   = $next;
	}
	return array(
		'unit'   => $unit,
		'points' => $out,
	);
}

/**
 * Classement des valeurs d'une colonne, en visites (une visite = une fois).
 */
function sm_top_sessions( $col, $w, $limit = 12, $extra = '' ) {
	return array_map(
		function ( $r ) {
			return array( $r['k'], (int) $r['n'] );
		},
		sm_all( "SELECT $col AS k, COUNT(*) AS n FROM hits WHERE $w AND type = 1 AND is_entry = 1 $extra GROUP BY $col ORDER BY n DESC LIMIT $limit" )
	);
}

function sm_report( $site, $period, $from = '', $to = '' ) {
	list( $s, $e, $label ) = sm_range( $period, $from, $to );
	$len    = (int) $s->diff( $e )->days;
	$ps     = $s->modify( "-$len days" );
	$w      = sm_where( $site, $s, $e );
	$wprev  = sm_where( $site, $ps, $s );
	$wentry = "$w AND type = 1 AND is_entry = 1";

	// Actions : nombre total et nombre de visites où l'action a eu lieu.
	$events = array();
	foreach ( sm_all( "SELECT event, COUNT(*) AS n, COUNT(DISTINCT session) AS v FROM hits WHERE $w AND type = 2 GROUP BY event ORDER BY n DESC" ) as $r ) {
		$events[] = array( $r['event'], (int) $r['n'], (int) $r['v'] );
	}

	// Randos : vues, visiteurs, téléchargements et autres actions sur la fiche.
	$randos = sm_all(
		"SELECT ref AS id, COALESCE(MAX(CASE WHEN event = 'rando' THEN label END), MAX(label)) AS name, MAX(site) AS site,
			SUM(event = 'rando') AS views,
			COUNT(DISTINCT CASE WHEN event = 'rando' THEN visitor END) AS people,
			SUM(event = 'gpx') AS gpx,
			SUM(event IN ('fly','fly_duel')) AS fly,
			SUM(event IN ('share','png')) AS share,
			SUM(event = 'audio') AS audio
		FROM hits WHERE $w AND type = 2 AND ref <> '' AND event IN ('rando','gpx','fly','fly_duel','share','png','audio')
		GROUP BY ref ORDER BY views DESC, gpx DESC LIMIT 25"
	);
	foreach ( $randos as &$r ) {
		foreach ( array( 'views', 'people', 'gpx', 'fly', 'share', 'audio' ) as $k ) {
			$r[ $k ] = (int) $r[ $k ];
		}
	}
	unset( $r );

	$label_top = function ( $event, $limit = 15 ) use ( $w ) {
		return array_map(
			function ( $r ) {
				return array( $r['k'], (int) $r['n'] );
			},
			sm_all( "SELECT label AS k, COUNT(*) AS n FROM hits WHERE $w AND type = 2 AND event = " . sm_db()->quote( $event ) . " AND label <> '' GROUP BY label ORDER BY n DESC LIMIT $limit" )
		);
	};

	// Carte d'affluence : jour de la semaine (lundi = 0) x heure.
	$heat = array_fill( 0, 7, array_fill( 0, 24, 0 ) );
	foreach ( sm_all( "SELECT CAST(strftime('%w', ts) AS INTEGER) AS d, CAST(strftime('%H', ts) AS INTEGER) AS h, COUNT(*) AS n FROM hits WHERE $wentry GROUP BY d, h" ) as $r ) {
		$heat[ ( (int) $r['d'] + 6 ) % 7 ][ (int) $r['h'] ] = (int) $r['n'];
	}

	// Durée des visites, par tranches.
	$dur_buckets = array(
		'Moins de 10 s' => 0,
		'10 à 30 s'     => 0,
		'30 s à 1 min'  => 0,
		'1 à 3 min'     => 0,
		'3 à 10 min'    => 0,
		'10 à 30 min'   => 0,
		'Plus de 30 min' => 0,
	);
	$bounds      = array( 10, 30, 60, 180, 600, 1800, PHP_INT_MAX );
	$names       = array_keys( $dur_buckets );
	foreach ( sm_all( "SELECT SUM(duration) AS d FROM hits WHERE $w AND type = 1 AND session <> '' GROUP BY session" ) as $r ) {
		foreach ( $bounds as $i => $b ) {
			if ( (int) $r['d'] < $b ) {
				++$dur_buckets[ $names[ $i ] ];
				break;
			}
		}
	}

	// Actions par visite, par tranches.
	$depth = array( '0' => 0, '1' => 0, '2-3' => 0, '4-6' => 0, '7-10' => 0, '11+' => 0 );
	foreach ( sm_all( "SELECT SUM(type = 2) AS n FROM hits WHERE $w AND type IN (1,2) AND session <> '' GROUP BY session" ) as $r ) {
		$n = (int) $r['n'];
		$k = 0 === $n ? '0' : ( 1 === $n ? '1' : ( $n <= 3 ? '2-3' : ( $n <= 6 ? '4-6' : ( $n <= 10 ? '7-10' : '11+' ) ) ) );
		++$depth[ $k ];
	}

	// Villes, avec coordonnées pour la carte.
	$cities = array_map(
		function ( $r ) {
			return array(
				'city'    => $r['city'],
				'country' => $r['country'],
				'n'       => (int) $r['n'],
				'lat'     => null === $r['lat'] ? null : (float) $r['lat'],
				'lon'     => null === $r['lon'] ? null : (float) $r['lon'],
			);
		},
		sm_all( "SELECT city, country, COUNT(*) AS n, AVG(lat) AS lat, AVG(lon) AS lon FROM hits WHERE $wentry AND city <> '' GROUP BY city, country ORDER BY n DESC LIMIT 300" )
	);

	// Journal des dernières visites.
	$recent = sm_all(
		"SELECT session, site, MIN(ts) AS start, MAX(ts) AS last, SUM(type = 1) AS pv, SUM(duration) AS dur,
			MAX(CASE WHEN is_entry = 1 THEN landing END) AS landing,
			MAX(src_type) AS src_type, MAX(src_name) AS src_name, MAX(city) AS city, MAX(country) AS country,
			MAX(device) AS device, MAX(browser) AS browser, MAX(os) AS os, MAX(app) AS app,
			MAX(browser_v) AS browser_v, MAX(os_v) AS os_v, MAX(brand) AS brand, MAX(model) AS model, MAX(res) AS res, MAX(scroll) AS scroll,
			GROUP_CONCAT(CASE WHEN type = 2 THEN event END) AS events
		FROM hits WHERE $w AND type IN (1,2) AND session <> '' GROUP BY session ORDER BY start DESC LIMIT 40"
	);
	foreach ( $recent as &$r ) {
		$r['pv']     = (int) $r['pv'];
		$r['dur']    = (int) $r['dur'];
		$r['app']    = (int) $r['app'];
		$r['events'] = $r['events'] ? explode( ',', $r['events'] ) : array();
		unset( $r['session'] );
	}
	unset( $r );

	$sites = array();
	foreach ( (array) sm_cfg( 'sites' ) as $k => $v ) {
		$sites[ $k ] = $v['name'];
	}

	$wn = "$w AND type IN (1,2)";
	return array(
		'site'      => $site,
		'sites'     => $sites,
		'period'    => array(
			'label' => $label,
			'from'  => $s->format( 'Y-m-d' ),
			'to'    => $e->modify( '-1 day' )->format( 'Y-m-d' ),
			'days'  => $len,
		),
		'geo_ready' => sm_geo_is_ready(),
		'asn_ready' => sm_asn_is_ready(),
		'rejects'   => sm_rejects( $site, $s, $e ),
		'labels'    => array(
			'events'  => sm_events(),
			'sources' => sm_source_labels(),
		),
		'kpis'      => sm_kpis( $w ),
		'prev'      => sm_kpis( $wprev ),
		'series'    => sm_series( $site, $s, $e ),
		'events'    => $events,
		'randos'    => $randos,
		'gpx_files' => $label_top( 'gpx' ),
		'searches'  => $label_top( 'search', 25 ),
		'filters'   => $label_top( 'filter', 15 ),
		'ailleurs'  => $label_top( 'ailleurs', 10 ),
		'outbound'  => $label_top( 'outbound', 12 ),
		'vs'        => $label_top( 'vs', 10 ),
		'sources'   => sm_top_sessions( 'src_type', $w, 10 ),
		'referrers' => sm_top_sessions( 'src_name', $w, 15, "AND src_type <> 'direct'" ),
		'campaigns' => sm_top_sessions( 'campaign', $w, 10, "AND campaign <> ''" ),
		'landing'   => sm_top_sessions( 'landing', $w, 10 ),
		'countries' => sm_top_sessions( 'country', $w, 15, "AND country <> ''" ),
		'cities'    => $cities,
		'devices'   => sm_top_sessions( 'device', $w ),
		'browsers'  => sm_top_sessions( 'browser', $w ),
		'os'        => sm_top_sessions( 'os', $w ),
		'screens'   => sm_top_sessions( 'screen', $w, 10, "AND screen <> ''" ),
		'browsers_v' => sm_top_sessions( "browser || CASE WHEN browser_v <> '' THEN ' ' || browser_v ELSE '' END", $w, 12 ),
		'os_v'      => sm_top_sessions( "os || CASE WHEN os_v <> '' THEN ' ' || os_v ELSE '' END", $w, 12 ),
		'brands'    => sm_top_sessions( 'brand', $w, 10, "AND brand <> ''" ),
		'models'    => sm_top_sessions( "brand || ' ' || model", $w, 15, "AND model <> ''" ),
		'res'       => sm_top_sessions( 'res', $w, 12, "AND res <> ''" ),
		'dpr'       => sm_top_sessions( 'dpr', $w, 6, "AND dpr <> ''" ),
		'net'       => sm_top_sessions( 'net', $w, 6, "AND net <> ''" ),
		'scroll'    => sm_scroll( $w ),
		'links'     => sm_link_labels( $w ),
		'ui'        => $label_top( 'ui', 30 ),
		'fiche_btns' => array_map(
			function ( $r ) {
				return array( $r['k'], (int) $r['n'], (int) $r['randos'] );
			},
			sm_all( "SELECT btn AS k, COUNT(*) AS n, COUNT(DISTINCT CASE WHEN ref <> '' THEN ref END) AS randos FROM hits WHERE $w AND type = 2 AND btn <> '' GROUP BY btn ORDER BY n DESC LIMIT 40" )
		),
		'langs'     => sm_top_sessions( 'lang', $w, 10, "AND lang <> ''" ),
		'themes'    => sm_top_sessions( 'theme', $w, 5, "AND theme <> ''" ),
		'apps'      => sm_top_sessions( 'app', $w, 2 ),
		'by_site'   => 'all' === $site ? sm_all( "SELECT site AS k, COUNT(DISTINCT session) AS n FROM hits WHERE $wn AND session <> '' GROUP BY site" ) : array(),
		'heatmap'   => $heat,
		'durations' => $dur_buckets,
		'depth'     => $depth,
		'recent'    => $recent,
		'widget'    => array(
			'total'  => (int) sm_one( "SELECT COUNT(*) FROM hits WHERE $w AND type = 3" ),
			'cities' => sm_all( "SELECT city AS k, COUNT(*) AS n FROM hits WHERE $w AND type = 3 AND city <> '' GROUP BY city ORDER BY n DESC LIMIT 8" ),
		),
		'generated' => date( 'c' ),
	);
}

/**
 * Visiteurs actifs dans les 5 dernières minutes et dernières actions.
 */
function sm_live( $site ) {
	$now   = time();
	$since = date( 'Y-m-d H:i:s', $now - 300 );
	$ws    = 'all' !== $site ? ' AND site = ' . sm_db()->quote( $site ) : '';
	$w     = "ts >= '$since'$ws";

	// Personnes présentes (activité dans les 5 dernières minutes), avec leur visite en cours.
	$people = sm_all(
		"SELECT h.site, h.session, MAX(h.city) AS city, MAX(h.country) AS country, MAX(h.device) AS device,
			MAX(h.browser) AS browser, MAX(h.os) AS os, MAX(h.src_type) AS src_type, MAX(h.src_name) AS src_name,
			MAX(h.app) AS app, MAX(h.ts) AS last, MAX(h.browser_v) AS browser_v, MAX(h.os_v) AS os_v,
			MAX(h.brand) AS brand, MAX(h.model) AS model, MAX(h.res) AS res,
			(SELECT MIN(ts) FROM hits s WHERE s.session = h.session) AS start,
			(SELECT COUNT(*) FROM hits s WHERE s.session = h.session AND s.type = 2) AS actions,
			(SELECT event || '|' || label FROM hits s WHERE s.session = h.session AND s.type = 2 ORDER BY s.id DESC LIMIT 1) AS doing
		FROM hits h WHERE h.$w AND h.type IN (1,2) AND h.session <> '' GROUP BY h.session ORDER BY last DESC LIMIT 30"
	);
	foreach ( $people as &$p ) {
		$p['since']   = max( 0, $now - strtotime( $p['start'] ) );
		$p['idle']    = max( 0, $now - strtotime( $p['last'] ) );
		$p['actions'] = (int) $p['actions'];
		$p['app']     = (int) $p['app'];
		list( $p['event'], $p['label'] ) = array_pad( explode( '|', (string) $p['doing'], 2 ), 2, '' );
		unset( $p['doing'], $p['session'], $p['start'], $p['last'] );
	}
	unset( $p );

	// Personnes actives minute par minute sur les 30 dernières minutes.
	$from   = $now - 30 * 60;
	$counts = array();
	foreach ( sm_all( "SELECT strftime('%Y-%m-%d %H:%M', ts) AS m, COUNT(DISTINCT visitor) AS n FROM hits WHERE ts >= '" . date( 'Y-m-d H:i:s', $from ) . "'$ws AND type IN (1,2) GROUP BY m" ) as $r ) {
		$counts[ $r['m'] ] = (int) $r['n'];
	}
	$minutes = array();
	for ( $t = $from + 60; $t <= $now; $t += 60 ) {
		$minutes[] = $counts[ date( 'Y-m-d H:i', $t ) ] ?? 0;
	}

	return array(
		'now'     => count( $people ),
		'people'  => $people,
		'minutes' => $minutes,
		'today'   => (int) sm_one( "SELECT COUNT(DISTINCT visitor) FROM hits WHERE day = '" . date( 'Y-m-d' ) . "'$ws AND type IN (1,2)" ),
		'feed'    => sm_all( "SELECT ts, event, label, city, device FROM hits WHERE type = 2$ws ORDER BY ts DESC LIMIT 12" ),
		'time'    => date( 'H:i:s' ),
	);
}

/**
 * Trafic écarté sur la période : par raison, et détail (pays, hébergeur, navigateur).
 */
function sm_rejects( $site, DateTimeImmutable $s, DateTimeImmutable $e ) {
	$w = "day >= '" . $s->format( 'Y-m-d' ) . "' AND day < '" . $e->format( 'Y-m-d' ) . "'" . ( 'all' !== $site ? ' AND site = ' . sm_db()->quote( $site ) : '' );
	return array(
		'reasons' => array_map(
			function ( $r ) {
				return array( $r['reason'], (int) $r['n'] );
			},
			sm_all( "SELECT reason, SUM(n) AS n FROM rejects WHERE $w GROUP BY reason ORDER BY n DESC" )
		),
		'countries' => array_map(
			function ( $r ) {
				return array( $r['detail'], (int) $r['n'] );
			},
			sm_all( "SELECT detail, SUM(n) AS n FROM rejects WHERE $w AND reason = 'country' GROUP BY detail ORDER BY n DESC LIMIT 10" )
		),
		'hosts' => array_map(
			function ( $r ) {
				return array( $r['detail'], (int) $r['n'] );
			},
			sm_all( "SELECT detail, SUM(n) AS n FROM rejects WHERE $w AND reason = 'datacenter' GROUP BY detail ORDER BY n DESC LIMIT 10" )
		),
	);
}

/**
 * Profondeur de lecture des pages (jusqu'où elles ont été descendues).
 */
function sm_scroll( $w ) {
	$b = array( 'Haut de page' => 0, 'Jusqu\'au quart' => 0, 'Jusqu\'à la moitié' => 0, 'Jusqu\'aux trois quarts' => 0, 'Jusqu\'en bas' => 0 );
	$sum = 0;
	$n   = 0;
	foreach ( sm_all( "SELECT scroll FROM hits WHERE $w AND type = 1 AND duration > 0" ) as $r ) {
		$v    = (int) $r['scroll'];
		$sum += $v;
		++$n;
		$k = $v < 5 ? 'Haut de page' : ( $v < 25 ? 'Jusqu\'au quart' : ( $v < 50 ? 'Jusqu\'à la moitié' : ( $v < 90 ? 'Jusqu\'aux trois quarts' : 'Jusqu\'en bas' ) ) );
		++$b[ $k ];
	}
	return array(
		'avg'     => $n ? (int) round( $sum / $n ) : 0,
		'buckets' => $b,
	);
}

/**
 * Liens externes suivis, par destination : les randos (ou sites) les plus cliquées pour chacune.
 */
function sm_link_labels( $w ) {
	$out = array();
	foreach ( array( 'blog', 'photos', 'relive', 'drive', 'route', 'video', 'ext_site', 'outbound' ) as $kind ) {
		$out[ $kind ] = array_map(
			function ( $r ) {
				return array( $r['k'], (int) $r['n'] );
			},
			sm_all( "SELECT label AS k, COUNT(*) AS n FROM hits WHERE $w AND type = 2 AND event = '$kind' AND label <> '' GROUP BY label ORDER BY n DESC LIMIT 8" )
		);
	}
	return $out;
}
