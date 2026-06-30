// Pool Side Roster — live data proxy (Vercel serverless function)
//
// Reads the PUBLIC roster sheet on the server side and hands it to the
// page as JSON. Because this runs on Vercel (not in the browser), there's
// no CORS problem, and because it only READS, you don't need any edit
// access to the sheet — it just has to be viewable by anyone with the link.
//
// It auto-discovers weekly tabs: every request it probes a rolling window
// of "WC d/m" tab names (a few weeks back, several weeks ahead) and returns
// whichever ones actually exist. So when management adds next week's sheet,
// it shows up in the app on its own — nothing to configure here.
//
// The page calls this at /api/roster.

const SHEET_ID = '1qbsN_5qDP_wB8reup_Hce2VbwwwQ-k7lffSKQDK2cko';

// How many weeks to look behind / ahead of the current week.
const WEEKS_BACK = 2;
const WEEKS_AHEAD = 6;

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

// Monday of the week containing date d (UTC).
function mondayOf(d) {
  const x = new Date(d);
  const day = (x.getUTCDay() + 6) % 7;        // 0 = Monday
  x.setUTCDate(x.getUTCDate() - day);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
function isoOf(d) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}`;
}
// Tab name convention: "WC d/m" using the Monday's date, no leading zeros.
function wcName(d) { return `WC ${d.getUTCDate()}/${d.getUTCMonth() + 1}`; }

function windowTabs() {
  const base = mondayOf(new Date());
  const tabs = [];
  for (let i = -WEEKS_BACK; i <= WEEKS_AHEAD; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i * 7);
    tabs.push({ name: wcName(d), start: isoOf(d) });
  }
  return tabs;
}

async function readTab(name) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=`
    + encodeURIComponent(name);
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await r.text();
  // if Google returns a sign-in/HTML page (tab missing or not public), treat as unavailable
  if (/^\s*</.test(text) || /sign in/i.test(text.slice(0, 300))) return null;
  const cells = {};
  parseCSV(text).forEach(row => {
    const label = (row[0] || '').trim();
    if (label) cells[label] = row.slice(1, 8).map(x => (x || '').trim());
  });
  return Object.keys(cells).length ? cells : null;
}

module.exports = async (req, res) => {
  const tabs = windowTabs();
  const sheets = {};
  await Promise.all(tabs.map(async tab => {
    try { const cells = await readTab(tab.name); if (cells) sheets[tab.name] = cells; }
    catch (e) { /* skip this tab */ }
  }));

  // chronological list of the weeks that actually exist
  const weeks = tabs.filter(t => sheets[t.name]).map(t => ({ name: t.name, start: t.start }));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  res.status(200).json({ fetchedAt: new Date().toISOString(), weeks, sheets });
};
