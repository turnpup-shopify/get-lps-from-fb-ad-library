# Get Landing Pages from the Facebook Ad Library

Scrape a brand on the **Facebook Ad Library**, find the **websites behind its ads**,
count **how many ads point to each link**, and get a **preview link for every ad**.

It ships with two ways to use it:

- **Web UI** — type a brand, watch live progress, browse a sortable table, export CSV.
- **CLI** — one command, prints a table and/or writes CSV + JSON.

## How it works

The Ad Library web app loads ad data from Facebook's internal GraphQL endpoint.
Instead of scraping the obfuscated, ever-changing DOM, this tool drives a headless
Chromium browser (via Playwright) to the public search page, **intercepts those
GraphQL responses**, and pulls structured ad records straight out of the JSON —
each ad's destination/landing URL and its ad archive id. It scrolls to trigger
pagination until no more ads load (or a cap is hit), then aggregates:

- **destination URLs are normalized** — Facebook `l.facebook.com/l.php?u=…`
  redirects are unwrapped, and tracking params (`utm_*`, `fbclid`, `gclid`, …)
  are stripped so the same landing page doesn't split into many "different" links.
- results are **grouped by website (domain)** or **exact landing URL**.
- every ad gets a **preview permalink**: `https://www.facebook.com/ads/library/?id=<AD_ID>`.

## Requirements

- **Node.js 18+** (developed on Node 22).
- **Outbound network access to `facebook.com`.** The scraper must be able to reach
  the public Ad Library. In locked-down/proxied environments where `facebook.com`
  is blocked by an egress policy, the scrape will fail with a tunnel/403 error —
  run it somewhere Facebook is reachable.

## Install

```bash
npm install
# Installs Playwright's Chromium if needed. In managed environments that
# pre-install Chromium, the app auto-detects it (see "Browser binary" below).
npx playwright install chromium   # only if you don't already have a browser
```

## Web UI

```bash
npm start
# open http://localhost:3000
```

Enter a brand (e.g. `Allbirds`), pick a country and a max ad count, choose grouping,
and hit **Scrape**. You'll see live progress, then a table of websites with ad
counts and per-ad preview links, plus **Summary CSV** / **All ads CSV** downloads.

You can also **paste a full Ad Library URL** straight into the box — handy when
you've set up filters/sorting on facebook.com (active-only, sort by impressions,
a specific Page, etc.) and just want to scrape exactly that view. Or target a
Page by id with `page:123456789`.

### Quick saved searches — `config/searches.txt`

The fastest way to save reusable searches. One per line, `LABEL = URL`:

```
# config/searches.txt  — edit and refresh the page, no restart needed
AG1 = https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&media_type=all&search_type=page&sort_data[mode]=total_impressions&sort_data[direction]=desc&view_all_page_id=183869772601
AG2 = https://www.facebook.com/ads/library/?...
```

Just copy a URL from your browser's address bar on the Ad Library, paste it here
with a label, and it appears in the **Saved brands** dropdown. Picking it loads
that exact URL (filters, sorting and all).

### Configurable brand dropdown

The UI shows an optional **Saved brands** dropdown populated from
[`config/brands.json`](config/brands.json). Edit that file and refresh the page —
no restart needed. Each entry:

```json
{
  "brands": [
    { "label": "Allbirds", "query": "Allbirds", "country": "US" },
    { "label": "Gymshark", "query": "Gymshark", "country": "US", "max": 500 },
    { "label": "My Client (by Page)", "pageId": "123456789012345", "country": "US" }
  ]
}
```

- `label` — text shown in the dropdown.
- `query` — keyword search **or** use `pageId` for a specific Facebook Page.
- `country` (optional) — 2-letter code applied when the brand is picked.
- `max` (optional) — ad cap applied when the brand is picked.

Picking a brand just fills the form fields; you can still edit them or type a
brand freehand. If the file is missing or empty, the dropdown is simply hidden.

## CLI

```bash
node src/cli.js --brand "Allbirds" --country US --max 200
# or scrape a full URL directly (positional arg works too):
node src/cli.js --url "https://www.facebook.com/ads/library/?...&view_all_page_id=183869772601"
```

Options:

| Flag | Description | Default |
|------|-------------|---------|
| `-b, --brand <name>` | Brand / keyword to search | — |
| `-u, --url <url>` | Full Ad Library URL to scrape (keeps its filters/sorting) | — |
| `--page-id <id>` | Search a specific Facebook Page id instead of a keyword | — |
| `-c, --country <code>` | 2-letter country code | `US` |
| `-m, --max <n>` | Max ads to collect | `300` |
| `-g, --group <mode>` | Group by `domain` or `url` | `domain` |
| `-o, --out <basename>` | Write `<basename>-summary.csv`, `-ads.csv`, `.json` | — |
| `--json` | Print full JSON to stdout | — |
| `--show-browser` | Run with a visible browser (debugging) | — |

Example that saves all three files:

```bash
node src/cli.js --brand "Ridge Wallet" --group url --out ridge
# → ridge-summary.csv, ridge-ads.csv, ridge.json
```

## Output

**Summary** (one row per website):

| website | ad_count | landing_urls | ad_preview_urls |
|---------|----------|--------------|-----------------|
| allbirds.com | 42 | https://allbirds.com/… | https://facebook.com/ads/library/?id=… \| … |

**All ads** (one row per ad): domain, landing URL, ad preview URL, CTA, title,
page name, start date, ad archive id, and the raw link.

## Browser binary

`src/scraper.js` resolves a Chromium executable in this order:

1. `CHROMIUM_PATH` env var, if set and it exists.
2. The newest `chromium-*/chrome-linux/chrome` under `PLAYWRIGHT_BROWSERS_PATH`
   (handy in managed environments that pre-install a specific build).
3. Playwright's bundled browser (from `npx playwright install`).

It also honors `HTTPS_PROXY` / `HTTP_PROXY` for outbound traffic.

## Test

```bash
npm test   # verifies GraphQL extraction + aggregation against a synthetic payload
```

## Notes & limits

- Facebook markup and GraphQL shapes change over time. The extractor is written
  defensively (it walks the JSON for any object with an `ad_archive_id`), but if
  Facebook restructures things you may need to adjust `src/scraper.js`.
- This scrapes only the **public** Ad Library — no login, no private data.
- Be considerate with request volume and respect Facebook's Terms of Service.
- Some ad formats (lead forms, app installs) have no outbound website; those are
  bucketed under `(no destination link)` so they still show up in the counts.
