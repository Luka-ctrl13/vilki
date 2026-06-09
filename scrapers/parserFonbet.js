// Fonbet (fonbet.kz) live parser — via its public JSON line API.
//
// Pure fetch, no browser: Fonbet serves the whole live line as one gzipped JSON
// document from a CDN host, reachable from data-center IPs (unlike 1xBet). That
// makes the whole scanner browser-free and cloud-deployable.
//
//   GET {LINE}/events/list?lang=ru&version=0&scopeMarket=1600
//
// Shape: { sports:[{id,kind,name,alias,parentId}], events:[{id,sportId,team1,
//          team2,startTime,place}], customFactors:[{e:eventId, factors:[{f,v,pt}]}] }
//   place === "live"  -> live event
//   factor f 930/931 = Total Over/Under  (pt = line)
//   factor f 927/928 = Handicap 1/2      (pt = signed line)
//
// Output (shared with the Olimp parser):
//   { team1, team2, sport, live, link,
//     totals:[{val,over,under}], handicaps:[{param1,kf1,param2,kf2}] }

// Mirror hosts — Fonbet rotates these; the first that answers wins. Override the
// whole list via FONBET_LINE_URL (comma-separated).
const LINE_HOSTS = (process.env.FONBET_LINE_URL ||
  "https://line52w.bk6bba-resources.com," +
  "https://line02w.bk6bba-resources.com," +
  "https://line20w.bk6bba-resources.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SITE = process.env.FONBET_SITE_URL || "https://fonbet.kz";

// Root sportId -> [label, url alias].
const ROOTS = {
  1: ["Футбол", "football"],
  2: ["Хоккей", "hockey"],
  3: ["Баскетбол", "basketball"],
  4: ["Теннис", "tennis"],
  9: ["Волейбол", "volleyball"],
  3088: ["Наст. теннис", "table-tennis"],
};

const F_TOTAL_OVER = 930, F_TOTAL_UNDER = 931;
const F_HANDICAP_1 = 927, F_HANDICAP_2 = 928;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

async function fetchLine() {
  let lastErr;
  for (const host of LINE_HOSTS) {
    try {
      const res = await fetch(`${host}/events/list?lang=ru&version=0&scopeMarket=1600`, { headers: HEADERS });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no Fonbet host responded");
}

// Map every sportId (segment) to its root sport id by walking parentId.
function buildRootMap(sports) {
  const byId = new Map(sports.map((s) => [s.id, s]));
  const cache = new Map();
  const rootOf = (id) => {
    if (cache.has(id)) return cache.get(id);
    let s = byId.get(id), guard = 0;
    while (s && s.parentId && byId.has(s.parentId) && guard++ < 10) s = byId.get(s.parentId);
    const root = s ? s.id : id;
    cache.set(id, root);
    return root;
  };
  return rootOf;
}

function parse(payload) {
  const sports = payload.sports || [];
  const rootOf = buildRootMap(sports);
  const factorsByEvent = new Map((payload.customFactors || []).map((c) => [c.e, c.factors || []]));
  const out = [];

  for (const ev of payload.events || []) {
    if (ev.place !== "live" || !ev.team1 || !ev.team2) continue;
    const rootId = rootOf(ev.sportId);
    const root = ROOTS[rootId];
    if (!root) continue; // only sports we scan
    const [label, alias] = root;

    const factors = factorsByEvent.get(ev.id) || [];
    const totals = extractTotals(factors);
    const handicaps = extractHandicaps(factors);
    if (!totals.length && !handicaps.length) continue;

    out.push({
      team1: ev.team1,
      team2: ev.team2,
      sport: label,
      live: true,
      link: `${SITE}/live/${alias}/${ev.sportId}/${ev.id}`,
      totals,
      handicaps,
    });
  }
  return out;
}

function num(pt, fallback) {
  const v = parseFloat(pt);
  return isNaN(v) ? fallback : v;
}

function extractTotals(factors) {
  const over = factors.find((f) => f.f === F_TOTAL_OVER && f.v > 1);
  const under = factors.find((f) => f.f === F_TOTAL_UNDER && f.v > 1);
  if (!over || !under) return [];
  const val = num(over.pt, num(under.pt, null));
  if (val === null) return [];
  return [{ val, over: over.v, under: under.v }];
}

function extractHandicaps(factors) {
  const h1 = factors.find((f) => f.f === F_HANDICAP_1 && f.v > 1);
  const h2 = factors.find((f) => f.f === F_HANDICAP_2 && f.v > 1);
  if (!h1 || !h2) return [];
  return [{ param1: num(h1.pt, 0), kf1: h1.v, param2: num(h2.pt, 0), kf2: h2.v }];
}

async function getLiveEvents() {
  const data = await fetchLine();
  return parse(data);
}

module.exports = { getLiveEvents, parse, extractTotals, extractHandicaps };
