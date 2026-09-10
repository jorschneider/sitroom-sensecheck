// Situation Room Evals — judge portal backend.
// Bound to the "Situation Room Evals — Judge Responses" sheet.
// Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.

const SHEET = 'Sheet1';
const COLS = ['timestamp','judge','round','sub','cat','share','works','improve','next','note','order','fin_note'];

function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET);
  sh.appendRow(COLS.map(c => c === 'timestamp' ? new Date() : (d[c] == null ? '' : (typeof d[c] === 'object' ? JSON.stringify(d[c]) : d[c]))));
  return out({ ok: true });
}

// GET ?judge=Kevin  -> that judge's latest state
// GET ?all=1        -> everyone's latest state (Jordan)
function doGet(e) {
  const p = e.parameter || {};
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET);
  const rows = sh.getDataRange().getValues().slice(1);
  const latest = {};
  rows.forEach(r => {
    const o = {}; COLS.forEach((c, i) => o[c] = r[i]);
    if (!o.judge) return;
    if (p.judge && o.judge !== p.judge) return;
    const k = o.judge + '|' + o.round + '|' + o.sub;
    latest[k] = o; // rows are chronological, so last wins
  });
  return out({ ok: true, rows: Object.values(latest) });
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
