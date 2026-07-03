// Web server + JSON/SSE API for the Facebook Ad Library landing-page scraper.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scrapeAdLibrary } from './scraper.js';
import { aggregate, toSummaryCsv, toAdsCsv } from './aggregate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

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
  const country = (req.query.country || 'US').toString().trim().toUpperCase().slice(0, 2) || 'US';
  const maxAds = clampInt(req.query.max, 300, 1, 2000);
  const groupBy = req.query.group === 'url' ? 'url' : 'domain';

  if (!brand && !pageId) {
    res.status(400).json({ error: 'Provide a brand keyword or pageId.' });
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
      country,
      maxAds,
      headless: true,
      onProgress: (msg, data) => send('progress', { msg, ...(data || {}) }),
    });

    const summary = aggregate(ads, groupBy);
    const runId = `${Date.now()}-${Math.floor(ads.length)}-${brand || pageId}`.replace(/\s+/g, '_');
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
