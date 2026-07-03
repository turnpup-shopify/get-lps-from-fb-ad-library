// Front-end: drive the SSE scrape endpoint and render results.
const $ = (id) => document.getElementById(id);
const form = $('scrapeForm');
const statusEl = $('status');
const resultsEl = $('results');
const rowsEl = $('rows');
const logEl = $('log');

let currentSource = null;
let savedBrands = [];
let sheetConfigured = false;
let lastRender = null;        // { groups, brandFallback }
let lastSearchLabel = '';     // brand typed for this run ('' for URL searches)

// Is the Google Sheet endpoint configured? Controls whether the buttons show.
async function initSheet() {
  try {
    const res = await fetch('/api/sheet/status');
    sheetConfigured = !!(await res.json()).configured;
  } catch {
    sheetConfigured = false;
  }
  $('sheetCol').style.display = sheetConfigured ? '' : 'none';
  $('addAllSheet').style.display = sheetConfigured ? '' : 'none';
  if (lastRender) render(lastRender.data, lastRender.group); // re-render if late
}
initSheet();

// Populate the optional "Saved brands" dropdown from config/brands.json.
async function loadSavedBrands() {
  try {
    const res = await fetch('/api/brands');
    const data = await res.json();
    savedBrands = data.brands || [];
  } catch {
    savedBrands = [];
  }
  if (!savedBrands.length) return;

  const sel = $('savedBrands');
  savedBrands.forEach((b, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = b.pageId && !b.query ? `${b.label} (Page ${b.pageId})` : b.label;
    sel.appendChild(opt);
  });
  $('savedBrandsRow').style.display = 'flex';

  sel.addEventListener('change', () => {
    const b = savedBrands[Number(sel.value)];
    if (!b) return;
    if (b.url) $('brand').value = b.url;
    else if (b.pageId && !b.query) $('brand').value = `page:${b.pageId}`;
    else $('brand').value = b.query;
    if (b.country) $('country').value = b.country;
    if (b.max) $('max').value = b.max;
  });
}
loadSavedBrands();

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function logLine(text) {
  const d = document.createElement('div');
  d.textContent = `· ${text}`;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (currentSource) currentSource.close();

  let brand = $('brand').value.trim();
  let pageId = '';
  let url = '';
  if (/^https?:\/\//i.test(brand)) {
    url = brand; brand = '';
  } else {
    const pageMatch = brand.match(/^page:\s*(\d+)$/i);
    if (pageMatch) { pageId = pageMatch[1]; brand = ''; }
  }

  const country = ($('country').value.trim() || 'US').toUpperCase();
  const max = $('max').value || 300;
  const group = $('group').value;
  lastSearchLabel = brand; // '' when a URL/pageId was used

  rowsEl.innerHTML = '';
  logEl.innerHTML = '';
  resultsEl.style.display = 'none';
  statusEl.classList.add('show');
  $('statusMsg').textContent = 'Starting…';
  $('statusCount').textContent = '';
  $('go').disabled = true;

  const params = new URLSearchParams({ brand, pageId, url, country, max, group });
  const src = new EventSource(`/api/scrape?${params.toString()}`);
  currentSource = src;

  src.addEventListener('progress', (ev) => {
    const d = JSON.parse(ev.data);
    $('statusMsg').textContent = d.msg;
    if (d.count != null) $('statusCount').textContent = `— ${d.count} ads`;
    logLine(`${d.msg}${d.count != null ? `: ${d.count}` : ''}`);
  });

  src.addEventListener('done', (ev) => {
    const data = JSON.parse(ev.data);
    render(data, group);
    statusEl.classList.remove('show');
    $('go').disabled = false;
    src.close();
    currentSource = null;
  });

  src.addEventListener('error', (ev) => {
    let msg = 'Connection error.';
    try { msg = JSON.parse(ev.data).error; } catch {}
    $('statusMsg').innerHTML = `<span class="error">Error: ${esc(msg)}</span>`;
    document.querySelector('.spinner').style.display = 'none';
    $('go').disabled = false;
    src.close();
    currentSource = null;
  });
});

// Build a Google Sheet row from a result group.
function groupToRow(g) {
  const brand = (g.ads.find((a) => a.pageName) || {}).pageName || lastSearchLabel || '';
  const link = g.landingUrls[0] || (g.domain ? `https://${g.domain}` : '');
  return {
    site: g.website || g.domain || '(no destination link)',
    link,
    brand,
    image: '',
    type: '',
    adCount: g.adCount,
    previewUrl: g.previewUrls[0] || '',
    landingUrls: g.landingUrls,
  };
}

function setSheetStatus(msg, cls) {
  const el = $('sheetStatus');
  el.textContent = msg;
  el.className = 'sheet-status' + (cls ? ' ' + cls : '');
}

async function postRows(rows) {
  const res = await fetch('/api/sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  return res.json();
}

function render(data, group) {
  lastRender = { data, group };
  $('sAds').textContent = data.totalAds;
  $('sGroups').textContent = data.uniqueGroups;
  $('sGroupsLabel').textContent = group === 'url' ? 'unique landing URLs' : 'unique websites';
  $('sTop').textContent = data.groups[0]?.website || '–';
  $('searchLink').href = data.searchUrl;
  $('dlSummary').href = `/api/export/${encodeURIComponent(data.runId)}/summary`;
  $('dlAds').href = `/api/export/${encodeURIComponent(data.runId)}/ads`;

  rowsEl.innerHTML = '';
  data.groups.forEach((g, i) => {
    const website = g.website || '(no destination link)';
    const href = g.landingUrls[0] || (g.domain ? `https://${g.domain}` : '#');
    const previews = g.previewUrls
      .map((u, idx) => `<a href="${esc(u)}" target="_blank" rel="noopener">ad ${idx + 1}</a>`)
      .join('');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="muted">${i + 1}</td>
      <td><span class="count-pill">${g.adCount}</span></td>
      <td class="web"><a href="${esc(href)}" target="_blank" rel="noopener">${esc(website)}</a></td>
      <td><div class="previews">${previews}</div></td>
      ${sheetConfigured ? '<td></td>' : ''}`;
    if (sheetConfigured) {
      const btn = document.createElement('button');
      btn.className = 'row-sheet-btn';
      btn.textContent = '➕ Sheet';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Adding…';
        const r = await postRows([groupToRow(g)]).catch((e) => ({ success: false, error: e.message }));
        if (r.success) {
          btn.textContent = r.addedCount ? '✓ Added' : '• Duplicate';
        } else {
          btn.textContent = '⚠ Failed';
          btn.disabled = false;
          setSheetStatus(`Error: ${r.error || 'failed'}`, 'bad');
        }
      });
      tr.lastElementChild.appendChild(btn);
    }
    rowsEl.appendChild(tr);
  });

  resultsEl.style.display = 'block';
  if (data.totalAds === 0) {
    const cols = sheetConfigured ? 5 : 4;
    rowsEl.innerHTML = `<tr><td colspan="${cols}" class="muted">No ads found. Try a different keyword, country, or check the brand's exact name on the Ad Library.</td></tr>`;
  }
}

// "Add all to Google Sheet" — push every result group.
$('addAllSheet').addEventListener('click', async () => {
  if (!lastRender) return;
  const btn = $('addAllSheet');
  const rows = lastRender.data.groups.map(groupToRow);
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = `Adding ${rows.length}…`;
  setSheetStatus('Sending to Google Sheet…', '');
  const r = await postRows(rows).catch((e) => ({ success: false, error: e.message }));
  if (r.success) {
    setSheetStatus(`Added ${r.addedCount}, skipped ${r.skippedCount} duplicate(s).`, 'ok');
  } else {
    setSheetStatus(`Error: ${r.error || 'failed'}`, 'bad');
  }
  btn.textContent = original;
  btn.disabled = false;
});
