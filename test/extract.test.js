// Verifies GraphQL extraction + end-to-end aggregation without a live scrape.
// Uses a synthetic payload shaped like Facebook Ad Library GraphQL responses.
import assert from 'node:assert';
import { extractAdsFromText } from '../src/scraper.js';
import { aggregate } from '../src/aggregate.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
};

// A realistic nested response: results live deep inside connection edges, one
// ad is a carousel (cards[]), and the body has a `for (;;);` guard prefix plus
// a second concatenated JSON object (mimicking streamed/paginated responses).
const fbLikeResponse =
  'for (;;);' +
  JSON.stringify({
    data: {
      ad_library_main: {
        search_results_connection: {
          edges: [
            {
              node: {
                collated_results: [
                  {
                    ad_archive_id: '1001',
                    start_date: 1690000000,
                    snapshot: {
                      page_name: 'Allbirds',
                      link_url: 'https://allbirds.com/products/mens?utm_source=facebook&fbclid=x',
                      caption: 'allbirds.com',
                      cta_text: 'Shop now',
                      title: 'Tree Runners',
                      cards: [],
                    },
                  },
                  {
                    ad_archive_id: '1002',
                    start_date: 1690500000,
                    snapshot: {
                      page_name: 'Allbirds',
                      link_url: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fallbirds.com%2Fsale%3Futm_medium%3Dcpc&h=abc',
                      caption: 'allbirds.com',
                      cta_text: 'Shop now',
                      cards: [],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  }) +
  JSON.stringify({
    data: {
      results: [
        {
          ad_archive_id: '2001',
          snapshot: {
            page_name: 'Allbirds',
            // carousel: destination lives on the first card
            link_url: null,
            cards: [
              { link_url: 'https://other-partner.com/deal?ref=fb', title: 'Card 1', cta_text: 'Learn more' },
              { link_url: 'https://other-partner.com/deal2', title: 'Card 2' },
            ],
          },
        },
      ],
    },
  });

check('extracts ads from nested + carousel + multi-object response', () => {
  const ads = extractAdsFromText(fbLikeResponse);
  assert.strictEqual(ads.length, 3, `expected 3 ads, got ${ads.length}`);
  const byId = Object.fromEntries(ads.map((a) => [a.adArchiveId, a]));
  assert.ok(byId['1001'] && byId['1002'] && byId['2001']);
  assert.strictEqual(byId['1001'].ctaText, 'Shop now');
  assert.strictEqual(byId['1001'].startDate, '2023-07-22'); // unix→ISO date
  // carousel ad picks up the first card's link
  assert.strictEqual(byId['2001'].linkUrl, 'https://other-partner.com/deal?ref=fb');
});

check('ignores responses without ad_archive_id', () => {
  assert.strictEqual(extractAdsFromText('{"data":{"foo":1}}').length, 0);
  assert.strictEqual(extractAdsFromText('').length, 0);
});

check('aggregates by domain with counts + preview links', () => {
  const ads = extractAdsFromText(fbLikeResponse);
  const summary = aggregate(ads, 'domain');
  assert.strictEqual(summary.totalAds, 3);
  const allbirds = summary.groups.find((g) => g.domain === 'allbirds.com');
  assert.strictEqual(allbirds.adCount, 2, 'both allbirds ads (incl. FB-redirect) collapse to one domain');
  assert.strictEqual(allbirds.previewUrls.length, 2);
  assert.strictEqual(allbirds.previewUrls[0], 'https://www.facebook.com/ads/library/?id=1001');
  const partner = summary.groups.find((g) => g.domain === 'other-partner.com');
  assert.strictEqual(partner.adCount, 1);
});

console.log(`\n${passed} test group(s) passed.\n`);
