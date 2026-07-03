// URL helpers: unwrap Facebook redirect wrappers, strip tracking params,
// derive a normalized landing URL and its registrable-ish domain.

// Query params that are pure tracking noise and should not create
// "different" landing pages when grouping.
const TRACKING_PARAMS = [
  'fbclid', 'gclid', 'msclkid', 'ttclid', 'twclid', 'igshid', 'mc_cid', 'mc_eid',
  '_ga', 'yclid', 'vero_id', 'ref', 'ref_src',
];
const TRACKING_PREFIXES = ['utm_', 'hsa_', 'wickedid', 'epik'];

// Multi-part public suffixes we want to keep intact when deriving a domain.
const TWO_LEVEL_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'com.au', 'net.au', 'org.au', 'com.br',
  'com.mx', 'co.nz', 'co.jp', 'co.in', 'com.sg', 'co.za', 'com.tr', 'com.hk',
]);

/** Facebook wraps outbound links as l.facebook.com/l.php?u=<encoded>. Unwrap it. */
export function unwrapFacebookRedirect(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (/(^|\.)facebook\.com$/i.test(u.hostname) && u.pathname === '/l.php') {
      const target = u.searchParams.get('u');
      if (target) return decodeURIComponent(target);
    }
  } catch {
    /* not a parseable URL; return as-is */
  }
  return rawUrl;
}

function isTrackingParam(key) {
  const k = key.toLowerCase();
  if (TRACKING_PARAMS.includes(k)) return true;
  return TRACKING_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Normalize a landing URL for grouping: unwrap FB redirects, force https,
 * lowercase host, drop tracking params, drop trailing slash and fragment.
 * Returns the original string if it can't be parsed.
 */
export function normalizeUrl(rawUrl) {
  if (!rawUrl) return '';
  const unwrapped = unwrapFacebookRedirect(rawUrl.trim());
  let u;
  try {
    u = new URL(unwrapped);
  } catch {
    return unwrapped;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return unwrapped;

  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  u.hash = '';

  const kept = [];
  for (const [key, value] of u.searchParams.entries()) {
    if (!isTrackingParam(key)) kept.push([key, value]);
  }
  u.search = '';
  kept.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, value] of kept) u.searchParams.append(key, value);

  let out = `https://${u.hostname}${u.pathname}${u.search}`;
  out = out.replace(/\/$/, '');
  return out;
}

/** Registrable-ish domain, e.g. "shop.brand.co.uk" -> "brand.co.uk". */
export function getDomain(rawUrl) {
  if (!rawUrl) return '';
  const unwrapped = unwrapFacebookRedirect(rawUrl.trim());
  let host;
  try {
    host = new URL(unwrapped).hostname.toLowerCase();
  } catch {
    return '';
  }
  host = host.replace(/^www\./, '');
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LEVEL_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

/** Public Ad Library permalink for a single ad. */
export function adPreviewUrl(adArchiveId) {
  return `https://www.facebook.com/ads/library/?id=${adArchiveId}`;
}
