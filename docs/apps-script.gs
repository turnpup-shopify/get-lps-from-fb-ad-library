/**
 * Google Apps Script Web App — appends landing-page rows to your Google Sheet,
 * de-duplicating by link. Pairs with this app's "Add to Google Sheet" button.
 *
 * Matches a sheet with these columns (in this order):
 *   sites | links | brands | images | Type
 *
 * DEPLOY / REDEPLOY
 * 1. Open the target Google Sheet → Extensions → Apps Script.
 * 2. Delete the existing code, paste this whole file, and Save.
 * 3. Deploy → Manage deployments → Edit (pencil) → Version: "New version" →
 *    Deploy.  (Editing the existing deployment keeps your current /exec URL.)
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. (Optional) Require a token: Project Settings → Script Properties →
 *    API_TOKEN = <secret>, and set the same value as SHEET_TOKEN in the app.
 *
 * Sanity check: open the /exec URL in a browser → {"success":true,"status":"ready"}
 *
 * Request  : POST JSON { token, rows:[{site,link,brand,image,type}] }
 * Response : { success, addedCount, skippedCount }  or  { success:false, error }
 */

// Leave '' to use the first tab in the spreadsheet, or set your tab's name.
const SHEET_NAME = '';

// Column order written to the sheet: sites, links, brands, images, Type.
// Change the field names here if your columns are in a different order.
const COLUMNS = ['site', 'link', 'brand', 'image', 'type'];

// 1-based index (within COLUMNS) of the column used to detect duplicates.
const DEDUPE_COL = 2; // "links"

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    const required = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
    if (required && body.token !== required) {
      return json({ success: false, error: 'Invalid token' });
    }

    const rows = Array.isArray(body.rows) ? body.rows : [];
    const sheet = getSheet();
    const existing = getExistingValues(sheet, DEDUPE_COL);

    let added = 0;
    let skipped = 0;
    const toAppend = [];
    rows.forEach((r) => {
      const dedupeKey = String(r[COLUMNS[DEDUPE_COL - 1]] || '').trim();
      if (dedupeKey && existing.has(dedupeKey)) { skipped++; return; }
      if (dedupeKey) existing.add(dedupeKey);
      toAppend.push(COLUMNS.map((field) => valueOf(r[field])));
      added++;
    });

    if (toAppend.length) {
      sheet
        .getRange(sheet.getLastRow() + 1, 1, toAppend.length, COLUMNS.length)
        .setValues(toAppend);
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
  if (SHEET_NAME) {
    return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  }
  return ss.getSheets()[0];
}

// Values already present in the dedupe column (skips the header row).
function getExistingValues(sheet, col) {
  const set = new Set();
  const last = sheet.getLastRow();
  if (last < 2) return set;
  sheet.getRange(2, col, last - 1, 1).getValues().forEach((v) => {
    if (v[0] !== '' && v[0] != null) set.add(String(v[0]).trim());
  });
  return set;
}

function valueOf(v) {
  return v == null ? '' : v;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
