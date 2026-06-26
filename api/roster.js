// Pool Side Roster — live data proxy (Vercel serverless function)
//
// Reads the PUBLIC roster sheet on the server side and hands it to the
// page as JSON. Because this runs on Vercel (not in the browser), there's
// no CORS problem, and because it only READS, you don't need any edit
// access to the sheet — it just has to be viewable by anyone with the link.
//
// The page calls this at /api/roster. Nothing to configure.

const SHEET_ID = '1qbsN_5qDP_wB8reup_Hce2VbwwwQ-k7lffSKQDK2cko';

// The weekly tabs to read. gid is used when known (most reliable);
// otherwise it falls back to selecting the tab by its name.
const TABS = [
  { name: 'WC 22/6', gid: '1094158465' },
  { name: 'WC 29/6', gid: null },
  { name: 'WC 6/7',  gid: null },
];

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function readTab(tab) {
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&`;
  const url = tab.gid
    ? base + 'gid=' + tab.gid
    : base + 'sheet=' + encodeURIComponent(tab.name);
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await r.text();
  // if Google returns a sign-in/HTML page instead of CSV, treat as unavailable
  if (/^\s*</.test(text) || /sign in/i.test(text.slice(0, 300))) return null;
  const cells = {};
  parseCSV(text).forEach(row => {
    const label = (row[0] || '').trim();
    if (label) cells[label] = row.slice(1, 8).map(x => (x || '').trim());
  });
  return Object.keys(cells).length ? cells : null;
}

module.exports = async (req, res) => {
  const sheets = {};
  await Promise.all(TABS.map(async tab => {
    try { const cells = await readTab(tab); if (cells) sheets[tab.name] = cells; }
    catch (e) { /* skip this tab */ }
  }));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  res.status(200).json({ fetchedAt: new Date().toISOString(), sheets });
};
