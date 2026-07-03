// Front-end: drive the SSE scrape endpoint and render results.
const $ = (id) => document.getElementById(id);
const form = $('scrapeForm');
const statusEl = $('status');
const resultsEl = $('results');
const rowsEl = $('rows');
const logEl = $('log');

let currentSource = null;

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
  const pageMatch = brand.match(/^page:\s*(\d+)$/i);
  if (pageMatch) { pageId = pageMatch[1]; brand = ''; }

  const country = ($('country').value.trim() || 'US').toUpperCase();
  const max = $('max').value || 300;
  const group = $('group').value;

  rowsEl.innerHTML = '';
  logEl.innerHTML = '';
  resultsEl.style.display = 'none';
  statusEl.classList.add('show');
  $('statusMsg').textContent = 'Starting…';
  $('statusCount').textContent = '';
  $('go').disabled = true;

  const params = new URLSearchParams({ brand, pageId, country, max, group });
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

function render(data, group) {
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
      <td><div class="previews">${previews}</div></td>`;
    rowsEl.appendChild(tr);
  });

  resultsEl.style.display = 'block';
  if (data.totalAds === 0) {
    rowsEl.innerHTML = `<tr><td colspan="4" class="muted">No ads found. Try a different keyword, country, or check the brand's exact name on the Ad Library.</td></tr>`;
  }
}
