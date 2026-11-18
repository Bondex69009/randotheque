<?php
/**
 * Reconnaissance des robots, de l'origine des visites et des appareils.
 */

/**
 * Robots, outils de test et navigateurs automatisés.
 */
function sm_is_bot( $ua ) {
	if ( strlen( $ua ) < 40 ) {
		return true;
	}
	$pattern = '~bot\b|bot/|crawl|spider|slurp|scrap|archiver|fetch|curl|wget|python|java/|go-http|httpclient|okhttp|axios|node-fetch|guzzle|'
		. 'headless|phantom|selenium|puppeteer|playwright|webdriver|lighthouse|pagespeed|gtmetrix|pingdom|uptime|statuscake|site24x7|'
		. 'facebookexternalhit|facebookcatalog|whatsapp|telegram|discord|skype|slack|embedly|bingpreview|preview|'
		. 'semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|chatgpt-user|oai-searchbot|claude-|anthropic|perplexity|ccbot|applebot|yandex|baidu|'
		. 'google-inspectiontool|googleother|feedfetcher|wordpress|wp-rocket|prerender|validator|monitor|electron|cypress|httrack|scan|probe|check|zgrab|nmap|censys|masscan~i';
	return (bool) preg_match( $pattern, $ua );
}

/* -------------------------------------------------------------------------
 * Origine du visiteur
 * ---------------------------------------------------------------------- */

function sm_source_labels() {
	return array(
		'direct'   => 'Accès direct',
		'search'   => 'Moteurs de recherche',
		'social'   => 'Réseaux sociaux',
		'ai'       => 'Assistants IA',
		'email'    => 'E-mails',
		'paid'     => 'Publicité payante',
		'campaign' => 'Campagnes',
		'referral' => 'Autres sites',
	);
}

/**
 * Classe l'origine d'une visite : [type, nom, campagne].
 */
function sm_source( $referrer, array $utm, $site_host ) {
	$u = array();
	foreach ( array( 'source', 'medium', 'campaign' ) as $k ) {
		$u[ $k ] = mb_substr( sm_clean_text( (string) ( $utm[ $k ] ?? '' ), 100 ), 0, 100 );
	}
	$campaign = $u['campaign'];
	$us       = strtolower( $u['source'] );
	$um       = strtolower( $u['medium'] );

	if ( ! empty( $utm['gclid'] ) ) {
		return array( 'paid', 'Google Ads', $campaign );
	}
	if ( ! empty( $utm['msclkid'] ) ) {
		return array( 'paid', 'Microsoft Ads', $campaign );
	}

	if ( $us || $um ) {
		$name = $u['source'] ? ucfirst( $u['source'] ) : 'Campagne';
		if ( preg_match( '/cpc|ppc|paid|ads?\b|display|banner|sponsor/', $um ) ) {
			return array( 'paid', $name, $campaign );
		}
		if ( preg_match( '/e-?mail|newsletter|mailchimp|brevo|sendinblue/', $um . ' ' . $us ) ) {
			return array( 'email', $name, $campaign );
		}
		if ( preg_match( '/social|^sm$|facebook|instagram|linkedin|twitter|tiktok|pinterest|youtube/', $um . ' ' . $us ) ) {
			return array( 'social', $name, $campaign );
		}
		return array( 'campaign', $name, $campaign );
	}

	$host = strtolower( (string) parse_url( $referrer, PHP_URL_HOST ) );
	$host = preg_replace( '/^www\./', '', $host );
	$site = preg_replace( '/^www\./', '', strtolower( (string) $site_host ) );

	if ( ! empty( $utm['fbclid'] ) && ( '' === $host || $host === $site ) ) {
		return array( 'social', 'Facebook', '' );
	}
	if ( '' === $host || $host === $site ) {
		return array( 'direct', 'Accès direct', '' );
	}

	// L'ordre compte : mail.google.com et gemini.google.com avant google.
	$rules = array(
		array( 'ai', '/(^|\.)(chatgpt\.com|chat\.openai\.com)$/', 'ChatGPT' ),
		array( 'ai', '/(^|\.)perplexity\.ai$/', 'Perplexity' ),
		array( 'ai', '/(^|\.)claude\.ai$/', 'Claude' ),
		array( 'ai', '/^gemini\.google\.com$/', 'Gemini' ),
		array( 'ai', '/^copilot\.microsoft\.com$/', 'Copilot' ),
		array( 'ai', '/(^|\.)mistral\.ai$/', 'Le Chat (Mistral)' ),
		array( 'ai', '/(^|\.)deepseek\.com$/', 'DeepSeek' ),
		array( 'email', '/^mail\.google\.com$/', 'Gmail' ),
		array( 'email', '/^outlook\.(live|office|office365)\.com$/', 'Outlook' ),
		array( 'email', '/^mail\.yahoo\./', 'Yahoo Mail' ),
		array( 'email', '/(^|\.)(webmail|messagerie|mail)\./', 'Webmail' ),
		array( 'search', '/(^|\.)google\.[a-z.]+$/', 'Google' ),
		array( 'search', '/(^|\.)bing\.com$/', 'Bing' ),
		array( 'search', '/(^|\.)duckduckgo\.com$/', 'DuckDuckGo' ),
		array( 'search', '/(^|\.)qwant\.com$/', 'Qwant' ),
		array( 'search', '/(^|\.)ecosia\.org$/', 'Ecosia' ),
		array( 'search', '/(^|\.)yahoo\.[a-z.]+$/', 'Yahoo' ),
		array( 'search', '/(^|\.)(yandex\.[a-z.]+|ya\.ru)$/', 'Yandex' ),
		array( 'search', '/(^|\.)baidu\.com$/', 'Baidu' ),
		array( 'search', '/(^|\.)startpage\.com$/', 'Startpage' ),
		array( 'search', '/^search\.brave\.com$/', 'Brave Search' ),
		array( 'search', '/(^|\.)lilo\.org$/', 'Lilo' ),
		array( 'social', '/(^|\.)(facebook\.com|fb\.me|fb\.com)$/', 'Facebook' ),
		array( 'social', '/(^|\.)instagram\.com$/', 'Instagram' ),
		array( 'social', '/(^|\.)(t\.co|twitter\.com|x\.com)$/', 'X (Twitter)' ),
		array( 'social', '/(^|\.)(linkedin\.com|lnkd\.in)$/', 'LinkedIn' ),
		array( 'social', '/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/', 'Pinterest' ),
		array( 'social', '/(^|\.)(youtube\.com|youtu\.be)$/', 'YouTube' ),
		array( 'social', '/(^|\.)tiktok\.com$/', 'TikTok' ),
		array( 'social', '/(^|\.)reddit\.com$/', 'Reddit' ),
		array( 'social', '/(^|\.)snapchat\.com$/', 'Snapchat' ),
		array( 'social', '/(^|\.)threads\.(net|com)$/', 'Threads' ),
		array( 'social', '/(^|\.)bsky\.app$/', 'Bluesky' ),
		array( 'social', '/(^|\.)whatsapp\.com$/', 'WhatsApp' ),
	);
	foreach ( $rules as $rule ) {
		if ( preg_match( $rule[1], $host ) ) {
			return array( $rule[0], $rule[2], '' );
		}
	}
	return array( 'referral', $host, '' );
}

/* -------------------------------------------------------------------------
 * Appareil, navigateur, système
 * ---------------------------------------------------------------------- */

function sm_device( $ua, $touch_points ) {
	if ( preg_match( '/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i', $ua ) ) {
		return 'tablet';
	}
	if ( preg_match( '/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i', $ua ) ) {
		return 'mobile';
	}
	// Les iPad récents se présentent comme un Mac : on les reconnaît à l'écran tactile.
	if ( false !== stripos( $ua, 'Macintosh' ) && $touch_points > 1 ) {
		return 'tablet';
	}
	return 'desktop';
}

function sm_browser( $ua ) {
	$list = array(
		'/Edg(e|A|iOS)?\//'       => 'Edge',
		'/OPR\/|Opera/'           => 'Opera',
		'/SamsungBrowser/'        => 'Samsung Internet',
		'/Firefox|FxiOS/'         => 'Firefox',
		'/FBAN|FBAV|Instagram/'   => 'Appli Facebook / Instagram',
		'/CriOS|Chrome|Chromium/' => 'Chrome',
		'/Safari/'                => 'Safari',
	);
	foreach ( $list as $re => $name ) {
		if ( preg_match( $re, $ua ) ) {
			return $name;
		}
	}
	return 'Autre';
}

function sm_os( $ua, $touch_points ) {
	if ( preg_match( '/iPhone|iPod/', $ua ) ) {
		return 'iOS (iPhone)';
	}
	if ( preg_match( '/iPad/', $ua ) || ( false !== stripos( $ua, 'Macintosh' ) && $touch_points > 1 ) ) {
		return 'iPadOS';
	}
	$list = array(
		'/Android/'      => 'Android',
		'/Windows/'      => 'Windows',
		'/Mac OS X|Macintosh/' => 'macOS',
		'/CrOS/'         => 'ChromeOS',
		'/Linux/'        => 'Linux',
	);
	foreach ( $list as $re => $name ) {
		if ( preg_match( $re, $ua ) ) {
			return $name;
		}
	}
	return 'Autre';
}

/**
 * Vrai navigateur seulement : Chrome, Safari, Firefox, Edge, Opera, Samsung Internet…
 * (moteurs Blink, WebKit ou Gecko d'une version récente). Tout le reste est écarté.
 */
function sm_is_real_browser( $ua ) {
	if ( 0 !== strpos( $ua, 'Mozilla/5.0 (' ) ) {
		return false;
	}
	if ( preg_match( '~Chrome/(\d+)~', $ua, $m ) || preg_match( '~CriOS/(\d+)~', $ua, $m ) ) {
		return (int) $m[1] >= 90;
	}
	if ( preg_match( '~Firefox/(\d+)~', $ua, $m ) || preg_match( '~FxiOS/(\d+)~', $ua, $m ) ) {
		return (int) $m[1] >= 90;
	}
	if ( preg_match( '~Version/(\d+)[\d.]* (Mobile/\w+ )?Safari/~', $ua, $m ) ) {
		return (int) $m[1] >= 13;
	}
	// Safari intégré aux applis iOS (Facebook, Instagram, Gmail…).
	if ( preg_match( '~(iPhone|iPad|iPod).+AppleWebKit/~', $ua ) ) {
		return true;
	}
	return false;
}

function sm_screen( $w ) {
	$w = (int) $w;
	if ( $w <= 0 ) {
		return '';
	}
	if ( $w < 480 ) {
		return 'Moins de 480 px';
	}
	if ( $w < 768 ) {
		return '480 à 767 px';
	}
	if ( $w < 1024 ) {
		return '768 à 1023 px';
	}
	if ( $w < 1440 ) {
		return '1024 à 1439 px';
	}
	if ( $w < 1920 ) {
		return '1440 à 1919 px';
	}
	return '1920 px et plus';
}

function sm_lang( $l ) {
	$l = strtolower( substr( preg_replace( '/[^a-zA-Z-]/', '', (string) $l ), 0, 2 ) );
	return 2 === strlen( $l ) ? $l : '';
}

/**
 * Détails de l'appareil : version du navigateur et du système, marque et modèle.
 * $ch : « Client Hints » envoyés par Chrome / Edge / Samsung Internet (modèle exact, version réelle
 * du système), absents sur Safari et Firefox : on se rabat alors sur le User-Agent.
 */
function sm_device_details( $ua, array $ch, $touch ) {
	$clean = function ( $s, $max = 40 ) {
		return mb_substr( trim( preg_replace( '/[^\p{L}\p{N} ._\-+()]/u', '', (string) $s ) ), 0, $max );
	};
	$os = sm_os( $ua, $touch );

	// Version du navigateur (numéro principal).
	$bv = '';
	foreach ( array( '~Edg(?:e|A|iOS)?/(\d+)~', '~OPR/(\d+)~', '~SamsungBrowser/(\d+)~', '~(?:Firefox|FxiOS)/(\d+)~', '~CriOS/(\d+)~', '~Chrome/(\d+)~', '~Version/(\d+(?:\.\d+)?)~' ) as $re ) {
		if ( preg_match( $re, $ua, $m ) ) {
			$bv = $m[1];
			break;
		}
	}
	if ( ! empty( $ch['bv'] ) && preg_match( '/^(\d+)/', (string) $ch['bv'], $m ) ) {
		$bv = $m[1];
	}

	// Version du système.
	$ov = '';
	$pv = (string) ( $ch['pv'] ?? '' );
	if ( 'Windows' === $os ) {
		$major = (int) $pv;
		$ov    = '' !== $pv ? ( $major >= 13 ? '11' : '10' ) : ( preg_match( '~Windows NT 10~', $ua ) ? '10 ou 11' : '' );
	} elseif ( 'macOS' === $os ) {
		$ov = '' !== $pv ? preg_replace( '/^(\d+(?:\.\d+)?).*/', '$1', $pv ) : '';
	} elseif ( 'Android' === $os ) {
		$ov = '' !== $pv ? preg_replace( '/^(\d+).*/', '$1', $pv ) : ( preg_match( '~Android (\d+)~', $ua, $m ) && '10' !== $m[1] ? $m[1] : '' );
	} elseif ( preg_match( '~(?:iPhone OS|CPU OS) (\d+)(?:_(\d+))?~', $ua, $m ) ) {
		$ov = $m[1] . ( isset( $m[2] ) ? '.' . $m[2] : '' );
	} elseif ( preg_match( '~Version/(\d+)~', $ua, $m ) && 'iPadOS' === $os ) {
		$ov = $m[1];
	}

	// Marque et modèle.
	$model = $clean( $ch['model'] ?? '' );
	if ( '' === $model && preg_match( '~Android [\d.]+; ([^;)]+)\)~', $ua, $m ) && 'K' !== trim( $m[1] ) ) {
		$model = $clean( preg_replace( '~ Build/.*~', '', $m[1] ) );
	}
	$brand = '';
	if ( in_array( $os, array( 'iOS (iPhone)', 'iPadOS', 'macOS' ), true ) ) {
		$brand = 'Apple';
		$model = 'iOS (iPhone)' === $os ? 'iPhone' : ( 'iPadOS' === $os ? 'iPad' : 'Mac' );
	} elseif ( '' !== $model ) {
		$brands = array(
			'/^SM-|^Galaxy|samsung/i'          => 'Samsung',
			'/^Pixel/i'                        => 'Google',
			'/^(Redmi|POCO|Mi |M2|2\d{3}|Xiaomi)/i' => 'Xiaomi',
			'/^(CPH|OPPO)/i'                   => 'Oppo',
			'/^RMX|realme/i'                   => 'Realme',
			'/^(moto|XT\d)/i'                  => 'Motorola',
			'/OnePlus|^(GM|HD|IN|KB|LE|NE|PJ)\d{4}/i' => 'OnePlus',
			'/^(HUAWEI|ELE-|VOG-|ANE-|MAR-|LYA-|JNY-)/i' => 'Huawei',
			'/^(Nokia|TA-)/i'                  => 'Nokia',
			'/^(V\d{4}|vivo)/i'                => 'Vivo',
			'/^(A\d{3}|Nothing)/i'             => 'Nothing',
			'/^(SO-|XQ-|Xperia)/i'             => 'Sony',
			'/^(LM-|LG)/i'                     => 'LG',
			'/^(Infinix|TECNO)/i'              => 'Transsion',
			'/^(Lenovo|TB-)/i'                 => 'Lenovo',
			'/^Fairphone|^FP\d/i'              => 'Fairphone',
		);
		foreach ( $brands as $re => $name ) {
			if ( preg_match( $re, $model ) ) {
				$brand = $name;
				break;
			}
		}
		if ( '' === $brand ) {
			$brand = 'Autre Android';
		}
	} elseif ( 'Windows' === $os ) {
		$brand = 'PC Windows';
	} elseif ( in_array( $os, array( 'Linux', 'ChromeOS' ), true ) ) {
		$brand = $os;
	}

	return array(
		'browser_v' => $bv,
		'os_v'      => $ov,
		'brand'     => $brand,
		'model'     => $model,
	);
}
