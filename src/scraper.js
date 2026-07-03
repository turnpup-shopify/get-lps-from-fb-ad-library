// Facebook Ad Library scraper.
//
// Strategy: the Ad Library web app fetches ad data from Facebook's internal
// GraphQL endpoint. Rather than scrape the obfuscated, frequently-changing DOM,
// we drive a headless browser to the search page, intercept those GraphQL
// responses, and pull structured ad records straight out of the JSON. Then we
// scroll to trigger pagination until no new ads load.

import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const AD_LIBRARY_BASE = 'https://www.facebook.com/ads/library/';

/**
 * Resolve a usable Chromium binary. Playwright's default expects a build number
 * that matches the installed npm package, but managed environments often
 * pre-install a different Chromium build under PLAYWRIGHT_BROWSERS_PATH. Prefer
 * an explicit override, then any pre-installed chromium build's chrome binary,
 * and otherwise fall back to Playwright's bundled default.
 */
function resolveExecutablePath() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(base)) {
    const dirs = readdirSync(base)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      const candidate = join(base, d, 'chrome-linux', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined; // let Playwright use its bundled browser
}

/** Build the public Ad Library search URL for a brand keyword. */
export function buildSearchUrl({ brand, country = 'US', pageId = '' }) {
  const params = new URLSearchParams({
    active_status: 'all',
    ad_type: 'all',
    country,
    media_type: 'all',
  });
  if (pageId) {
    params.set('view_all_page_id', String(pageId));
    params.set('search_type', 'page');
  } else {
    params.set('q', brand);
    params.set('search_type', 'keyword_unordered');
  }
  return `${AD_LIBRARY_BASE}?${params.toString()}`;
}

/**
 * Validate a user-supplied Ad Library URL. We only ever navigate to
 * facebook.com so a pasted URL can't be used to drive the browser elsewhere.
 * Returns the URL unchanged if valid; throws otherwise.
 */
export function assertAdLibraryUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid URL: ${rawUrl}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('URL must be http(s).');
  }
  if (!/(^|\.)facebook\.com$/i.test(u.hostname)) {
    throw new Error('URL must be a facebook.com Ad Library link.');
  }
  return rawUrl;
}

/**
 * Split a Facebook response body (which may be a `for (;;);` prefixed object,
 * newline-delimited JSON, or several concatenated JSON objects) into parsed
 * JS values. Anything that doesn't parse is skipped.
 */
function parseMultiJson(text) {
  if (!text) return [];
  let body = text.trim();
  if (body.startsWith('for (;;);')) body = body.slice('for (;;);'.length);

  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const chunk = body.slice(start, i + 1);
        try {
          results.push(JSON.parse(chunk));
        } catch {
          /* partial/streamed chunk — ignore */
        }
        start = -1;
      }
    }
  }
  return results;
}

/**
 * Recursively walk a parsed GraphQL payload and collect ad records. We look for
 * objects carrying an `ad_archive_id` (or `adArchiveID`) and mine their snapshot
 * for the destination link. Carousel ads expose per-card links too.
 */
function collectAdsFromNode(node, out, seen) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) collectAdsFromNode(item, out, seen);
    return;
  }

  const archiveId =
    node.ad_archive_id ?? node.adArchiveID ?? node.adArchiveId ?? null;

  if (archiveId != null) {
    const snapshot = node.snapshot || {};
    const id = String(archiveId);

    // Gather every candidate destination link on the ad and its cards.
    const links = [];
    const pushLink = (u) => {
      if (u && typeof u === 'string') links.push(u);
    };
    pushLink(snapshot.link_url);
    pushLink(snapshot.caption && looksLikeUrl(snapshot.caption) ? snapshot.caption : null);
    if (Array.isArray(snapshot.cards)) {
      for (const card of snapshot.cards) pushLink(card && card.link_url);
    }

    const primaryLink = links.find(Boolean) || '';
    const dedupeKey = `${id}::${primaryLink}`;
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      out.push({
        adArchiveId: id,
        linkUrl: primaryLink,
        caption: snapshot.caption || '',
        title: snapshot.title || (snapshot.cards?.[0]?.title ?? '') || '',
        ctaText: snapshot.cta_text || (snapshot.cards?.[0]?.cta_text ?? '') || '',
        pageName: snapshot.page_name || node.page_name || '',
        startDate: toDate(node.start_date ?? node.startDate),
      });
    }
  }

  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') collectAdsFromNode(val, out, seen);
  }
}

/**
 * Extract ad records from a raw GraphQL response body. Exposed for testing and
 * used by the live response handler.
 * @returns {Array} ad records
 */
export function extractAdsFromText(text) {
  const out = [];
  const seen = new Set();
  if (!text || !text.includes('ad_archive_id')) return out;
  for (const payload of parseMultiJson(text)) {
    collectAdsFromNode(payload, out, seen);
  }
  return out;
}

function looksLikeUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}

function toDate(v) {
  if (!v) return '';
  // Facebook sends unix seconds for these fields.
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

async function dismissDialogs(page) {
  // Best-effort: cookie banners and login nags block scrolling.
  const labels = [
    'Allow all cookies', 'Allow all Cookies', 'Only allow essential cookies',
    'Decline optional cookies', 'Accept All', 'Close', 'Not now',
  ];
  for (const label of labels) {
    try {
      const btn = page.getByRole('button', { name: label }).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ timeout: 1000 }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }
  // A login modal sometimes overlays the page; press Escape to dismiss.
  await page.keyboard.press('Escape').catch(() => {});
}

/**
 * Scrape ads for a brand.
 *
 * @param {object} opts
 * @param {string} opts.brand      brand / keyword to search
 * @param {string} [opts.country]  2-letter country code (default 'US')
 * @param {string} [opts.pageId]   search a specific Page id instead of keyword
 * @param {number} [opts.maxAds]   stop after roughly this many ads (default 300)
 * @param {boolean}[opts.headless] default true
 * @param {(msg:string, data?:object)=>void} [opts.onProgress]
 * @returns {Promise<{ ads: Array, searchUrl: string }>}
 */
export async function scrapeAdLibrary(opts) {
  const {
    brand,
    country = 'US',
    pageId = '',
    url = '',
    maxAds = 300,
    headless = true,
    onProgress = () => {},
  } = opts;

  // A pasted Ad Library URL wins — it carries filters (sort, active-only,
  // Page id, etc.) the brand/country form can't express.
  let searchUrl;
  if (url) {
    searchUrl = assertAdLibraryUrl(url.trim());
  } else if (brand || pageId) {
    searchUrl = buildSearchUrl({ brand, country, pageId });
  } else {
    throw new Error('Provide a brand keyword, a pageId, or a full Ad Library URL.');
  }
  onProgress('launching browser');

  // Route through an outbound proxy when the environment provides one. The
  // proxy's CA is expected to already be trusted by the browser (NSS) store,
  // so we do NOT disable TLS verification.
  const proxyServer =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY;

  const browser = await chromium.launch({
    headless,
    executablePath: resolveExecutablePath(),
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const collected = [];
  const seen = new Set();

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
    });
    const page = await context.newPage();

    // Capture ad data from every GraphQL-ish response.
    page.on('response', async (response) => {
      const url = response.url();
      if (!/\/api\/graphql|graphql\/?(\?|$)/.test(url)) return;
      let text;
      try {
        text = await response.text();
      } catch {
        return;
      }
      if (!text || !text.includes('ad_archive_id')) return;
      for (const payload of parseMultiJson(text)) {
        collectAdsFromNode(payload, collected, seen);
      }
    });

    onProgress('opening ad library', { searchUrl });
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await dismissDialogs(page);
    await page.waitForTimeout(1500);

    // Scroll to trigger lazy pagination. Stop when no new ads arrive for a
    // few consecutive scrolls, or we hit the cap.
    let stagnantRounds = 0;
    let lastCount = collected.length;
    const maxStagnant = 4;
    const hardScrollLimit = 400;

    for (let i = 0; i < hardScrollLimit; i++) {
      if (collected.length >= maxAds) {
        onProgress('reached max ads', { count: collected.length });
        break;
      }
      await page.mouse.wheel(0, 3000);
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await page.waitForTimeout(1800);

      if (collected.length > lastCount) {
        onProgress('loaded ads', { count: collected.length });
        lastCount = collected.length;
        stagnantRounds = 0;
      } else {
        stagnantRounds++;
        if (stagnantRounds === 2) await dismissDialogs(page);
        if (stagnantRounds >= maxStagnant) {
          onProgress('no more ads loading', { count: collected.length });
          break;
        }
      }
    }

    onProgress('done', { count: collected.length });
  } finally {
    await browser.close();
  }

  const ads = maxAds ? collected.slice(0, maxAds) : collected;
  return { ads, searchUrl };
}
