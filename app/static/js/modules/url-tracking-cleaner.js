// Tracking junk removed from pasted URLs (docs/ui/paste-sanitization.md).
//
// A pasted URL often carries campaign and click tracking that has nothing to
// do with the page: utm_* and a few dozen vendor click ids on any site, and
// per-site parameters (Amazon's /ref= and its search trail, YouTube's share
// token, Google's search bookkeeping). Pasting is the user's action, so the
// junk goes silently; nothing else about the URL changes: the parameters that
// remain keep their order and spelling, the fragment stays (text fragments are
// useful), and a URL with nothing to remove comes through byte for byte.
// Only pasted and dropped content is cleaned, never typed text or saved notes.
// Strip by allowlist of known tracking names, never by guessing: `v=` on
// YouTube, `q=` on a search and `id=` on a shop are the page.

// Any site: prefixes and exact names, compared in lower case.
const GLOBAL_PREFIXES = Object.freeze(['utm_']);
const GLOBAL_PARAMETERS = Object.freeze([
    'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'srsltid', 'msclkid', 'ttclid', 'twclid',
    'li_fat_id', 'igshid', 'mc_cid', 'mc_eid', 'mkt_tok', '_hsenc', '_hsmi', 'hsctatracking',
    'yclid', 'vero_id', 'vero_conv', 'oly_anon_id', 'oly_enc_id', 'wickedid', '_openstat',
    'rb_clickid', 's_cid', 'sc_cid', '_branch_match_id', '_branch_referrer',
]);

// Per site: a pattern over the lower-case hostname, the parameters and
// prefixes it adds, and a path pattern whose matches are removed.
const SITE_RULES = Object.freeze([
    Object.freeze({
        hosts: '(^|\\.)amazon\\.[a-z.]{2,}$',
        parameters: Object.freeze([
            'ref', 'ref_', 'tag', 'keywords', 'crid', 'sprefix', 'qid', 'sr', 'th', 'psc', 'linkcode',
            'linkid', 'ascsubtag', 'content-id', 'dib', 'dib_tag', 'rps', '_encoding', 'spla', 'sp_csd', 'aref',
        ]),
        prefixes: Object.freeze(['pd_rd_', 'pf_rd_']),
        path: '/ref=[^/?#]*',
    }),
    Object.freeze({
        hosts: '(^|\\.)(youtube\\.com|youtu\\.be|youtube-nocookie\\.com)$',
        parameters: Object.freeze(['si', 'feature', 'pp', 'kw', 'ab_channel']),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)open\\.spotify\\.com$',
        parameters: Object.freeze(['si', 'nd', 'context']),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)(twitter\\.com|x\\.com)$',
        parameters: Object.freeze(['s', 't', 'ref_src', 'ref_url', 'refsrc', 'cxt', 'src', 'cn']),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)(facebook\\.com|fb\\.com|fb\\.watch)$',
        parameters: Object.freeze([
            'mibextid', 'rdid', 'share_url', 'ref', 'refid', 'fref', 'sfnsn', 'comment_tracking', 'notif_id',
            'notif_t', 'hrc', 'ti', 'extid', 'vh', 'paipv', 'eav', '_rdr', '__xts__', '__eep__',
        ]),
        prefixes: Object.freeze(['__cft__', '__tn__', 'hc_']),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)instagram\\.com$',
        parameters: Object.freeze(['igsh', 'igshid', 'ig_rid', 'ig_mid']),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)tiktok\\.com$',
        parameters: Object.freeze([
            '_r', '_t', 'is_from_webapp', 'sender_device', 'sender_web_id', 'web_id', 'is_copy_url', 'checksum',
            'share_app_id', 'share_link_id', 'source', 'timestamp', 'user_id', 'u_code', 'preview_pb', 'tt_from',
            'enter_from', 'enter_method', 'share_item_id', 'refer',
        ]),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)linkedin\\.com$',
        parameters: Object.freeze([
            'trk', 'trackingid', 'lipi', 'licu', 'refid', 'midtoken', 'midsig', 'trkemail', 'eid', 'otptoken',
            'original_referer', 'rcm',
        ]),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)reddit\\.com$',
        parameters: Object.freeze(['rdt', 'share_id', 'ref', 'ref_source', 'ref_campaign', 'cid', 'iid', 'correlation_id']),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)ebay\\.[a-z.]{2,}$',
        parameters: Object.freeze([
            '_trkparms', '_trksid', '_from', 'mkcid', 'mkrid', 'mkevt', 'mkpid', 'campid', 'toolid', 'customid',
            'amdata', 'sspagename', 'itmmeta', 'itmprp', 'hash', 'siteid', 'ufes_redirect', 'ul_noapp', 'chn', 'norover',
        ]),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)aliexpress\\.[a-z.]{2,}$',
        parameters: Object.freeze([
            'spm', 'scm', 'pdp_npi', 'gatewayadapt', 'afsmppid', 'sk', 'terminal_id', '_randl_currency',
            '_randl_shipto', 'src', 'pdp_ext_f', 'curpageloguid', 'utparam-url',
        ]),
        prefixes: Object.freeze(['aff_', 'alb', 'algo_']),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)etsy\\.com$',
        parameters: Object.freeze(['ref', 'frs', 'sts', 'click_key', 'click_sum', 'rec_type', 'organic_search_click', 'plkey', 'pro']),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)google\\.[a-z.]{2,}$',
        parameters: Object.freeze([
            'ved', 'ei', 'sa', 'usg', 'sxsrf', 'uact', 'sclient', 'source', 'oq', 'gs_lcp', 'gs_lcrp', 'gs_lp',
            'gs_ssp', 'aqs', 'sourceid', 'biw', 'bih', 'dpr', 'client', 'rlz', 'fbs', 'iflsig', 'ie', 'oe',
        ]),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)bing\\.com$',
        parameters: Object.freeze([
            'cvid', 'form', 'pq', 'sp', 'sc', 'qs', 'sk', 'ghc', 'ghsh', 'ghacc', 'ghpl', 'showconv', 'pc', 'refig', 'pglt',
        ]),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)medium\\.com$',
        parameters: Object.freeze(['source', 'gi']),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)substack\\.com$',
        parameters: Object.freeze(['r', 'triedredirect', 'showwelcomeonshare', 'triggershare', 'isfreemail']),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)nytimes\\.com$',
        parameters: Object.freeze([
            'smid', 'smtyp', 'smvar', 'referringsource', 'sgrp', 'campaign_id', 'emc', 'instance_id', 'nl',
            'regi_id', 'segment_id', 'te', 'user_id',
        ]),
        prefixes: Object.freeze([]),
        path: '',
    }),
    Object.freeze({
        hosts: '(^|\\.)imdb\\.com$',
        parameters: Object.freeze(['ref_', 'rf']),
        prefixes: Object.freeze(['pf_rd_']),
        path: '',
    }),
]);

// scheme, authority, path, query (with its ?), fragment (with its #)
const URL_PARTS = '^(https?:\\/\\/)([^/?#]*)([^?#]*)(\\?[^#]*)?(#[\\s\\S]*)?$';
// A URL in running text: up to whitespace or a quote/bracket that cannot be part of it.
const URL_IN_TEXT = 'https?:\\/\\/[^\\s<>"\'`]+';
// Punctuation that ends a sentence, not a URL, when it trails one.
const TRAILING_PUNCTUATION = '.,;:!?';

function hostnameOf(authority) {
    return authority.replace(/^[^@]*@/, '').replace(/:\d*$/, '').toLowerCase();
}

function siteRulesFor(hostname) {
    return SITE_RULES.filter((rule) => new RegExp(rule.hosts, 'i').test(hostname));
}

function isTrackingParameter(rawKey, rules) {
    const key = rawKey.toLowerCase();
    if (GLOBAL_PARAMETERS.includes(key) || GLOBAL_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        return true;
    }
    return rules.some((rule) => rule.parameters.includes(key) || rule.prefixes.some((prefix) => key.startsWith(prefix)));
}

function cleanQuery(query, rules) {
    if (query === '') {
        return '';
    }
    const kept = query.slice(1).split('&').filter((pair) => {
        if (pair === '') {
            return true;
        }
        return !isTrackingParameter(pair.split('=')[0], rules);
    });
    if (kept.every((pair) => pair === '')) {
        return '';
    }
    return `?${kept.join('&')}`;
}

function cleanPath(path, rules) {
    let cleaned = path;
    for (const rule of rules) {
        if (rule.path !== '') {
            cleaned = cleaned.replace(new RegExp(rule.path, 'gi'), '');
        }
    }
    return cleaned;
}

// The URL without its tracking parameters, or the same string when there is
// nothing to remove or it is not an http(s) URL.
export function cleanTrackingFromUrl(url) {
    if (typeof url !== 'string') {
        throw new Error('cleanTrackingFromUrl expects a string');
    }
    const parts = new RegExp(URL_PARTS, 'i').exec(url);
    if (parts === null) {
        return url;
    }
    const [, scheme, authority, path, query, fragment] = parts;
    const rules = siteRulesFor(hostnameOf(authority));
    const cleanedQuery = cleanQuery(query === undefined ? '' : query, rules);
    const cleanedFragment = fragment === undefined ? '' : fragment;
    return `${scheme}${authority}${cleanPath(path, rules)}${cleanedQuery}${cleanedFragment}`;
}

// How many characters at the end of a URL match belong to the sentence around
// it: closing punctuation, and brackets with no opening partner in the URL.
function trailerLength(match) {
    let end = match.length;
    while (end > 0) {
        const character = match[end - 1];
        const before = match.slice(0, end - 1);
        if (TRAILING_PUNCTUATION.includes(character)) {
            end -= 1;
            continue;
        }
        if (character === ')' && (before.split('(').length - 1) < (before.split(')').length)) {
            end -= 1;
            continue;
        }
        if (character === ']' && (before.split('[').length - 1) < (before.split(']').length)) {
            end -= 1;
            continue;
        }
        break;
    }
    return match.length - end;
}

// Every http(s) URL in the text, cleaned in place; the text around each stays as it is.
export function cleanTrackingInText(text) {
    if (typeof text !== 'string') {
        throw new Error('cleanTrackingInText expects a string');
    }
    return text.replace(new RegExp(URL_IN_TEXT, 'gi'), (match) => {
        const trailer = trailerLength(match);
        const url = match.slice(0, match.length - trailer);
        return `${cleanTrackingFromUrl(url)}${match.slice(match.length - trailer)}`;
    });
}

// A pasted link: its href cleaned, and its text too when the text is that same URL.
export function cleanTrackingFromAnchor(href, text) {
    if (typeof href !== 'string' || typeof text !== 'string') {
        throw new Error('cleanTrackingFromAnchor expects href and text strings');
    }
    const cleanedHref = cleanTrackingFromUrl(href);
    if (text.trim() === href.trim()) {
        return { href: cleanedHref, text: text.replace(href.trim(), cleanedHref) };
    }
    return { href: cleanedHref, text };
}
