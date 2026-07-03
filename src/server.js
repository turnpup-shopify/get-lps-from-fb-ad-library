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
const SHEET_FILE = join(CONFIG_DIR, 'sheet.json');
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(join(__dirname, '..', 'public')));

// Google Sheet endpoint config: env vars win, else config/sheet.json. Read
// fresh each request so config edits apply without a restart.
function readSheetConfig() {
  let fileUrl = '';
  let fileToken = '';
  try {
    const cfg = JSON.parse(readFileSync(SHEET_FILE, 'utf8'));
    fileUrl = (cfg.webAppUrl || '').trim();
    fileToken = (cfg.token || '').trim();
  } catch {
    /* no file — fall back to env */
  }
  // Env overrides per-field, so a secret token can stay out of the committed
  // config while the (low-sensitivity) URL lives in config/sheet.json.
  return {
    webAppUrl: (process.env.SHEET_WEBAPP_URL || '').trim() || fileUrl,
    token: (process.env.SHEET_TOKEN || '').trim() || fileToken,
  };
}

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

// Whether the "Add to Google Sheet" button should show.
app.get('/api/sheet/status', (_req, res) => {
  res.json({ configured: !!readSheetConfig().webAppUrl });
});

// Forward rows to the user's Apps Script Web App. The URL/token stay
// server-side; the browser never sees them.
app.post('/api/sheet', async (req, res) => {
  const { webAppUrl, token } = readSheetConfig();
  if (!webAppUrl) {
    res.status(400).json({
      success: false,
      error: 'Google Sheet endpoint not configured. Set SHEET_WEBAPP_URL (env) or config/sheet.json.',
    });
    return;
  }
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) {
    res.status(400).json({ success: false, error: 'No rows to add.' });
    return;
  }
  try {
    const r = await fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, rows }),
      redirect: 'follow',
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Apps Script often returns an HTML login page if the deployment isn't
      // set to "Anyone" access — surface a useful hint instead of raw HTML.
      data = {
        success: false,
        error:
          `Unexpected non-JSON response from the Apps Script (HTTP ${r.status}). ` +
          'Check the deployment is a Web App with access set to "Anyone".',
      };
    }
    res.status(data.success === false ? 502 : 200).json(data);
  } catch (err) {
    res.status(502).json({
      success: false,
      error: `Failed to reach Google Sheet endpoint: ${err.message}`,
    });
  }
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
