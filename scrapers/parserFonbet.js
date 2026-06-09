// Fonbet (fonbet.kz) live parser — via its public JSON line API.
//
// Two-phase fetch strategy:
//   Phase 1: bulk list (scopeMarket=1600) — gets all live events + main markets
//   Phase 2: same endpoint with eventIds= — enriches live events with alt lines
//
// Shape: { sports:[{id,kind,name,alias,parentId}], events:[{id,sportId,team1,
//          team2,startTime,place}], customFactors:[{e:eventId, factors:[{f,v,pt}]}] }
//   place === "live"  -> live event
//   factor f 930/931 = Total Over/Under  (pt = line)
//   factor f 927/928 = Handicap 1/2      (pt = signed line)
//
// Alt total factor IDs (verified empirically):
//   Football  : 930/931 (main), 1793/1794, 1796/1797, 1802/1803
//   Basketball: 930/931 (main), 1696/1697, 1727/1728, 1730/1731
//   Tennis/TT : 1696/1697, 1727/1728, 1730/1731, 1848/1849
//   Volleyball: 1848/1849 (main)
//
// Output (shared with the Olimp parser):
//   { team1, team2, sport, live, link,
//     totals:[{val,over,under}], handicaps:[{param1,kf1,param2,kf2}] }

const LINE_HOSTS = (process.env.FONBET_LINE_URL ||
  "https://line52w.bk6bba-resources.com," +
  "https://line02w.bk6bba-resources.com," +
  "https://line20w.bk6bba-resources.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SITE = process.env.FONBET_SITE_URL || "https://fonbet.kz";

const ROOTS = {
  1: ["Футбол", "football"],
  2: ["Хоккей", "hockey"],
  3: ["Баскетбол", "basketball"],
  4: ["Теннис", "tennis"],
  9: ["Волейбол", "volleyball"],
  3088: ["Наст. теннис", "table-tennis"],
};

const F_HANDICAP_1 = 927, F_HANDICAP_2 = 928;

// Over factor IDs → known full-game total "over" factors across all sports.
// Each is paired with the next integer (even = under).
const OVER_FACTORS = new Set([930, 1793, 1796, 1802, 1696, 1727, 1730, 1848]);
const UNDER_FACTORS = new Set([931, 1794, 1797, 1803, 1697, 1728, 1731, 1849]);

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

async function fetchLine(extraParams = "") {
  let lastErr;
  for (const host of LINE_HOSTS) {
    try {
      const url = `${host}/events/list?lang=ru&version=0&scopeMarket=1600${extraParams}`;
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("no Fonbet host responded");
}

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

function parse(payload, extFactors) {
  const sports = payload.sports || [];
  const rootOf = buildRootMap(sports);

  // Use extended factors when available, else fall back to basic factors.
  const basicMap = new Map((payload.customFactors || []).map((c) => [c.e, c.factors || []]));
  const extMap = extFactors ? new Map((extFactors || []).map((c) => [c.e, c.factors || []])) : null;
  const factorsFor = (id) => (extMap && extMap.has(id) ? extMap.get(id) : basicMap.get(id)) || [];

  const out = [];
  for (const ev of payload.events || []) {
    if (ev.place !== "live" || !ev.team1 || !ev.team2) continue;
    const rootId = rootOf(ev.sportId);
    const root = ROOTS[rootId];
    if (!root) continue;
    const [label, alias] = root;

    const factors = factorsFor(ev.id);
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

// Collect all full-game totals using the extended factor ID set.
function extractTotals(factors) {
  const byLine = {};
  for (const f of factors) {
    if (f.v <= 1) continue;
    const line = num(f.pt, null);
    if (line === null || line <= 0) continue;
    if (OVER_FACTORS.has(f.f)) {
      (byLine[line] ||= { val: line }).over = f.v;
    } else if (UNDER_FACTORS.has(f.f)) {
      (byLine[line] ||= { val: line }).under = f.v;
    }
  }
  return Object.values(byLine)
    .filter((t) => t.over && t.under)
    .map((t) => ({ val: t.val, over: t.over, under: t.under }));
}

function extractHandicaps(factors) {
  const h1 = factors.find((f) => f.f === F_HANDICAP_1 && f.v > 1);
  const h2 = factors.find((f) => f.f === F_HANDICAP_2 && f.v > 1);
  if (!h1 || !h2) return [];
  return [{ param1: num(h1.pt, 0), kf1: h1.v, param2: num(h2.pt, 0), kf2: h2.v }];
}

async function getLiveEvents() {
  // Phase 1: get the full event list (fast bulk fetch).
  const base = await fetchLine();

  // Collect IDs of live events we care about.
  const rootOf = buildRootMap(base.sports || []);
  const liveIds = (base.events || [])
    .filter((e) => e.place === "live" && e.team1 && e.team2 && ROOTS[rootOf(e.sportId)])
    .map((e) => e.id);

  // Phase 2: re-request with eventIds= to get alternative market lines.
  // This is a single additional HTTP call that adds ~400 ms and typically
  // triples the number of total lines per event.
  let extFactors = null;
  if (liveIds.length) {
    try {
      const ext = await fetchLine(`&eventIds=${liveIds.join(",")}`);
      extFactors = ext.customFactors || null;
    } catch (_) {
      // Phase 2 is best-effort; fall back to basic factors on failure.
    }
  }

  return parse(base, extFactors);
}

module.exports = { getLiveEvents, parse, extractTotals, extractHandicaps };
