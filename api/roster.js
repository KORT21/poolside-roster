// Pool Side Roster — live data proxy (Vercel serverless function)
//
// Reads the PUBLIC roster sheet on the server side and hands it to the
// page as JSON. Because this runs on Vercel (not in the browser), there's
// no CORS problem, and because it only READS, you don't need any edit
// access to the sheet — it just has to be viewable by anyone with the link.
//
// Sheet discovery:
//   - The three current weeks (KNOWN below) are always read and trusted.
//   - It then probes the next several "WC d/m" tab names after the last
//     known week to pick up newly-added sheets automatically.
//   - Google's gviz endpoint quietly returns the DEFAULT sheet when you ask
//     for a tab name that doesn't exist, so a naive probe makes every future
//     week look real. We defeat that by first fetching a deliberately-bogus
//     name to capture that "missing tab" signature, then ignoring any probed
//     week whose data matches it. Only genuinely-existing sheets get through.
//
// The page calls this at /api/roster.

const SHEET_ID = '1qbsN_5qDP_wB8reup_Hce2VbwwwQ-k7lffSKQDK2cko';

// The real weeks that currently exist. Always read; the last one is the
// frontier we probe forward from.
const KNOWN = [
  { name: 'WC 22/6', start: '2026-06-22' },
  { name: 'WC 29/6', start: '2026-06-29' },
  { name: 'WC 6/7',  start: '2026-07-06' },
];
const PROBE_AHEAD = 8;   // weeks to look ahead of the last known week

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

function isoOf(d) {
  const z = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())}`;
}
function wcName(d) { return `WC ${d.getUTCDate()}/${d.getUTCMonth() + 1}`; }
function dateFromISO(iso) { const [Y, M, D] = iso.split('-').map(Number); return new Date(Date.UTC(Y, M - 1, D)); }

// raw CSV text for a tab, or null if Google gave us a sign-in / HTML page
async function readRaw(name) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=`
    + encodeURIComponent(name);
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const text = await r.text();
  if (/^\s*</.test(text) || /sign in/i.test(text.slice(0, 300))) return null;
  return text;
}
function toCells(text) {
  const cells = {};
  parseCSV(text).forEach(row => {
    const label = (row[0] || '').trim();
    if (label) cells[label] = row.slice(1, 8).map(x => (x || '').trim());
  });
  return Object.keys(cells).length ? cells : null;
}

module.exports = async (req, res) => {
  // Signature returned for a tab that doesn't exist (gviz falls back to the
  // default sheet). Used to reject phantom future weeks.
  let fallback = null;
  try { fallback = await readRaw('__no_tab__' + Math.random().toString(36).slice(2)); } catch (e) {}

  const knownNames = new Set(KNOWN.map(k => k.name));
  const cand = new Map();
  KNOWN.forEach(k => cand.set(k.name, k.start));

  // probe forward from the last known week
  const frontier = dateFromISO(KNOWN[KNOWN.length - 1].start);
  for (let i = 1; i <= PROBE_AHEAD; i++) {
    const d = new Date(frontier); d.setUTCDate(d.getUTCDate() + i * 7);
    cand.set(wcName(d), isoOf(d));
  }

  const sheets = {}, found = [];
  await Promise.all([...cand.entries()].map(async ([name, start]) => {
    try {
      const raw = await readRaw(name);
      if (!raw) return;
      // a probed (non-known) tab whose data equals the "missing" signature isn't real
      if (!knownNames.has(name) && fallback != null && raw === fallback) return;
      const cells = toCells(raw);
      if (!cells) return;
      sheets[name] = cells;
      found.push({ name, start });
    } catch (e) { /* skip */ }
  }));

  found.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
  res.status(200).json({ fetchedAt: new Date().toISOString(), weeks: found, sheets });
};
