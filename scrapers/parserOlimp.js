// Olimp (olimpbet.kz) live parser — via the site's own public JSON API.
//
// This replaces the old fragile DOM scraping. The line API needs no login, only
// an `x-platform` header, and returns clean structured odds with exact lines —
// so we get every total/handicap line instead of guessing numbers off the page.
//
//   GET https://olimpbet.kz/api/v2/events
//       ?locale=ru&sport-ids=100&live=true&page-size=N&statuses=OPEN&statuses=TRADING
//
// Markets used:
//   1003 TOTAL    -> outcome 1006 = Under, 1007 = Over  (PARAMETER_VALUE = line)
//   1004 HANDICAP -> outcome 1008 = home (Ф1), 1009 = away (Ф2)
//
// Output shape (shared with the 1xBet parser):
//   { team1, team2, sport, live, link,
//     totals:    [{ val, over, under }, ...],
//     handicaps: [{ param1, kf1, param2, kf2 }, ...] }   // param1 = home line

const BASE = process.env.OLIMP_BASE_URL || "https://olimpbet.kz";

// Olimp sportId -> [label, url slug]. The slug builds the deep link to the exact
// live event: /live/{slug}-{sportId}/{eventId} (verified against the live site).
const SPORTS = {
  100: ["Футбол", "football"],
  101: ["Теннис", "tennis"],
  102: ["Баскетбол", "basketball"],
  103: ["Хоккей", "hockey"],
  104: ["Волейбол", "volleyball"],
  110: ["Наст. теннис", "table_tennis"],
};

const TOTAL_MARKET = 1003;
const HANDICAP_MARKET = 1004;
const TOTAL_SIDE = { 1006: "under", 1007: "over" };
const HCAP_SIDE = { 1008: "home", 1009: "away" };

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
  "x-platform": "web-desktop",
  Referer: `${BASE}/live`,
};

function paramValue(prob) {
  const p = (prob.parameters || []).find((x) => x.type === "PARAMETER_VALUE");
  if (!p) return null;
  const v = parseFloat(p.value);
  return isNaN(v) ? null : v;
}

async function fetchSport(sportId) {
  const qs = new URLSearchParams();
  qs.append("locale", "ru");
  qs.append("sport-ids", String(sportId));
  qs.append("live", "true");
  qs.append("page-size", "60");
  qs.append("statuses", "OPEN");
  qs.append("statuses", "TRADING");

  const res = await fetch(`${BASE}/api/v2/events?${qs}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const [name, slug] = SPORTS[sportId] || [String(sportId), "all"];
  return parseEvents(json, name, `${slug}-${sportId}`);
}

function parseEvents(payload, sportName, sportPath) {
  const out = [];
  for (const ev of payload.items || []) {
    const comps = ev.competitors || [];
    if (comps.length < 2) continue;
    const homeIds = new Set(ev.homeCompetitorIds || []);
    const home = (comps.find((c) => homeIds.has(c.id)) || comps[0]).name;
    const away = (comps.find((c) => !homeIds.has(c.id)) || comps[1]).name;

    const markets = {};
    for (const m of ev.probabilities?.markets || []) markets[m.marketId] = m;

    out.push({
      team1: home,
      team2: away,
      sport: sportName,
      live: !!ev.live,
      link: `${BASE}/live/${sportPath}/${ev.id}`,
      totals: extractTotals(markets[TOTAL_MARKET]),
      handicaps: extractHandicaps(markets[HANDICAP_MARKET]),
    });
  }
  return out;
}

function extractTotals(market) {
  if (!market) return [];
  // Group Over/Under by line value.
  const byLine = {};
  for (const p of market.probabilities || []) {
    const side = TOTAL_SIDE[p.outcomeTypeId];
    const line = paramValue(p);
    const odd = p.odd;
    if (!side || line === null || !(odd > 1)) continue;
    (byLine[line] ||= { val: line })[side] = odd;
  }
  return Object.values(byLine)
    .filter((t) => t.over && t.under)
    .map((t) => ({ val: t.val, over: t.over, under: t.under }));
}

function extractHandicaps(market) {
  if (!market) return [];
  // Pair home(Ф1) and away(Ф2). They are complementary: home +h ↔ away -h, so we
  // key by the absolute line and join the two sides.
  const byKey = {};
  for (const p of market.probabilities || []) {
    const side = HCAP_SIDE[p.outcomeTypeId];
    const val = paramValue(p);
    const odd = p.odd;
    if (!side || val === null || !(odd > 1)) continue;
    const key = Math.abs(val).toFixed(2);
    const slot = (byKey[key] ||= {});
    if (side === "home") { slot.param1 = val; slot.kf1 = odd; }
    else { slot.param2 = val; slot.kf2 = odd; }
  }
  return Object.values(byKey).filter((h) => h.kf1 && h.kf2);
}

async function getLiveEvents() {
  const results = await Promise.allSettled(Object.keys(SPORTS).map((s) => fetchSport(Number(s))));
  const events = [];
  for (const r of results) if (r.status === "fulfilled") events.push(...r.value);
  return events;
}

module.exports = { getLiveEvents, parseEvents, extractTotals, extractHandicaps };
