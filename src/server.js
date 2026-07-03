// Web server + JSON/SSE API for the Facebook Ad Library landing-page scraper.
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scrapeAdLibrary } from './scraper.js';
import { aggregate, toSummaryCsv, toAdsCsv } from './aggregate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');
const BRANDS_FILE = join(CONFIG_DIR, 'brands.json');
const SEARCHES_FILE = join(CONFIG_DIR, 'searches.txt');
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

// Parse config/searches.txt — plain "LABEL = URL" lines, # comments ignored.
function readSearchesTxt() {
  let text;
  try {
    text = readFileSync(SEARCHES_FILE, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const label = line.slice(0, eq).trim();
    const url = line.slice(eq + 1).trim();
    if (label && /^https?:\/\//i.test(url)) out.push({ label, url });
  }
  return out;
}

// Parse config/brands.json — structured { label, query|pageId, country, max }.
function readBrandsJson() {
  try {
    const parsed = JSON.parse(readFileSync(BRANDS_FILE, 'utf8'));
    const brands = Array.isArray(parsed.brands) ? parsed.brands : [];
    return brands
      .filter((b) => b && (b.query || b.pageId || b.url) && b.label)
      .map((b) => ({
        label: String(b.label),
        query: b.query ? String(b.query) : '',
        pageId: b.pageId ? String(b.pageId) : '',
        url: b.url ? String(b.url) : '',
        country: b.country ? String(b.country).toUpperCase().slice(0, 2) : '',
        max: Number.isFinite(b.max) ? b.max : undefined,
      }));
  } catch {
    return [];
  }
}

// Dropdown = URL searches (searches.txt) first, then structured brands.json.
// Read fresh each request so config edits show up on refresh, no restart.
app.get('/api/brands', (_req, res) => {
  res.json({ brands: [...readSearchesTxt(), ...readBrandsJson()] });
});

// Simple in-memory cache of the last run per session so CSV export works
// without re-scraping. Keyed by an opaque id we hand back to the client.
const runs = new Map();

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// Streaming scrape: Server-Sent Events so the browser shows live progress.
app.get('/api/scrape', async (req, res) => {
  const brand = (req.query.brand || '').toString().trim();
  const pageId = (req.query.pageId || '').toString().trim();
  const directUrl = (req.query.url || '').toString().trim();
  const country = (req.query.country || 'US').toString().trim().toUpperCase().slice(0, 2) || 'US';
  const maxAds = clampInt(req.query.max, 300, 1, 2000);
  const groupBy = req.query.group === 'url' ? 'url' : 'domain';

  if (!brand && !pageId && !directUrl) {
    res.status(400).json({ error: 'Provide a brand keyword, pageId, or Ad Library URL.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    const { ads, searchUrl } = await scrapeAdLibrary({
      brand,
      pageId,
      url: directUrl,
      country,
      maxAds,
      headless: true,
      onProgress: (msg, data) => send('progress', { msg, ...(data || {}) }),
    });

    const summary = aggregate(ads, groupBy);
    const runId = `${Date.now()}-${Math.floor(ads.length)}-${brand || pageId || 'url'}`.replace(/\s+/g, '_');
    runs.set(runId, { ads, summary, searchUrl });
    if (runs.size > 50) runs.delete(runs.keys().next().value);

    send('done', { runId, searchUrl, ...summary });
  } catch (err) {
    send('error', { error: err.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// CSV downloads for a completed run.
app.get('/api/export/:runId/:kind', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) {
    res.status(404).send('Run not found or expired. Please scrape again.');
    return;
  }
  const kind = req.params.kind;
  let csv;
  let filename;
  if (kind === 'summary') {
    csv = toSummaryCsv(run.summary);
    filename = 'ad-library-summary.csv';
  } else if (kind === 'ads') {
    csv = toAdsCsv(run.ads);
    filename = 'ad-library-ads.csv';
  } else {
    res.status(400).send('Unknown export kind.');
    return;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Facebook Ad Library → Landing Pages`);
  console.log(`  Web UI running at http://localhost:${PORT}\n`);
});
