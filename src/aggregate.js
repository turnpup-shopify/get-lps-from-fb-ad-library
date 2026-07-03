// Turn a flat list of scraped ads into grouped summaries.
import { normalizeUrl, getDomain, adPreviewUrl } from './urls.js';

/**
 * @param {Array} ads  raw ads from the scraper, each: { adArchiveId, linkUrl,
 *                     caption, ctaText, title, pageName, startDate }
 * @param {'url'|'domain'} groupBy
 * @returns {{ groupBy, totalAds, uniqueGroups, groups: Array }}
 */
export function aggregate(ads, groupBy = 'domain') {
  const map = new Map();

  for (const ad of ads) {
    const landing = normalizeUrl(ad.linkUrl);
    const domain = getDomain(ad.linkUrl);
    // Ads with no outbound link (e.g. app-install / lead forms) are bucketed
    // together so they still appear in the report rather than vanishing.
    const key =
      groupBy === 'url'
        ? landing || '(no destination link)'
        : domain || '(no destination link)';

    if (!map.has(key)) {
      map.set(key, {
        key,
        domain,
        website: groupBy === 'url' ? landing : domain,
        count: 0,
        sampleLandingUrls: new Set(),
        ads: [],
      });
    }
    const g = map.get(key);
    g.count += 1;
    if (landing) g.sampleLandingUrls.add(landing);
    g.ads.push({
      adArchiveId: ad.adArchiveId,
      previewUrl: adPreviewUrl(ad.adArchiveId),
      landingUrl: landing,
      rawLinkUrl: ad.linkUrl || '',
      ctaText: ad.ctaText || '',
      title: ad.title || '',
      caption: ad.caption || '',
      pageName: ad.pageName || '',
      startDate: ad.startDate || '',
    });
  }

  const groups = [...map.values()]
    .map((g) => ({
      website: g.website,
      domain: g.domain,
      adCount: g.count,
      landingUrls: [...g.sampleLandingUrls],
      previewUrls: g.ads.map((a) => a.previewUrl),
      ads: g.ads,
    }))
    .sort((a, b) => b.adCount - a.adCount || a.website.localeCompare(b.website));

  return {
    groupBy,
    totalAds: ads.length,
    uniqueGroups: groups.length,
    groups,
  };
}

/** Flat CSV: one row per ad. */
export function toAdsCsv(ads) {
  const header = [
    'domain', 'landing_url', 'ad_preview_url', 'cta', 'title', 'page_name',
    'start_date', 'ad_archive_id', 'raw_link_url',
  ];
  const rows = [header.join(',')];
  for (const ad of ads) {
    rows.push(
      [
        getDomain(ad.linkUrl),
        normalizeUrl(ad.linkUrl),
        adPreviewUrl(ad.adArchiveId),
        ad.ctaText || '',
        ad.title || '',
        ad.pageName || '',
        ad.startDate || '',
        ad.adArchiveId || '',
        ad.linkUrl || '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return rows.join('\n');
}

/** Grouped CSV: one row per website, with ad count and preview links. */
export function toSummaryCsv(summary) {
  const header = ['website', 'domain', 'ad_count', 'landing_urls', 'ad_preview_urls'];
  const rows = [header.join(',')];
  for (const g of summary.groups) {
    rows.push(
      [
        g.website,
        g.domain,
        g.adCount,
        g.landingUrls.join(' | '),
        g.previewUrls.join(' | '),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return rows.join('\n');
}

function csvCell(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
