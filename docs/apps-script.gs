/**
 * Google Apps Script Web App — appends landing-page rows to a Google Sheet,
 * de-duplicating by link. Pairs with this app's "Add to Google Sheet" button.
 *
 * DEPLOY
 * 1. Open the target Google Sheet → Extensions → Apps Script.
 * 2. Paste this whole file in, save.
 * 3. (Optional) To require a token: Project Settings → Script Properties →
 *    add property API_TOKEN = <some-secret>. Put the same value in the app's
 *    config/sheet.json "token" (or SHEET_TOKEN env var).
 * 4. Deploy → New deployment → type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Deploy, authorize, and copy the Web app URL (…/exec).
 * 5. Put that URL in the app's config/sheet.json "webAppUrl" (or SHEET_WEBAPP_URL).
 *
 * Request  : POST JSON { token, rows:[{site,link,brand,image,type,adCount,previewUrl}] }
 * Response : { success, addedCount, skippedCount } or { success:false, error }
 */

const SHEET_NAME = 'Landing Pages';
const HEADERS = ['Site', 'Link', 'Brand', 'Image', 'Type', 'Ad Count', 'Preview URL', 'Date Added'];

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    const required = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
    if (required && body.token !== required) {
      return json({ success: false, error: 'Invalid token' });
    }

    const rows = Array.isArray(body.rows) ? body.rows : [];
    const sheet = getSheet();
    const existing = getExistingLinks(sheet);

    let added = 0;
    let skipped = 0;
    const toAppend = [];
    rows.forEach((r) => {
      const link = String(r.link || '').trim();
      if (link && existing.has(link)) { skipped++; return; }
      if (link) existing.add(link);
      toAppend.push([
        r.site || '', link, r.brand || '', r.image || '', r.type || '',
        r.adCount != null ? r.adCount : '', r.previewUrl || '', new Date(),
      ]);
      added++;
    });

    if (toAppend.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
    }
    return json({ success: true, addedCount: added, skippedCount: skipped });
  } catch (err) {
    return json({ success: false, error: String(err) });
  }
}

// Simple GET so you can sanity-check the deployment in a browser.
function doGet() {
  return json({ success: true, status: 'ready' });
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  return sh;
}

function getExistingLinks(sheet) {
  const set = new Set();
  const last = sheet.getLastRow();
  if (last < 2) return set;
  sheet.getRange(2, 2, last - 1, 1).getValues().forEach((v) => {
    if (v[0]) set.add(String(v[0]).trim());
  });
  return set;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
