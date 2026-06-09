// Leon.bet (leon.ru) live parser — via the site's public JSON API.
//
// No browser required. All live events and markets are available at:
//   GET https://leon.ru/api-2/betline/events/all
//       ?ctag=ru-RU&sport_id={id}&hideClosed=true&flags=reg,urlv2,mm2,rrc,nodup&limit=50
//
// Live events: those where e.liveStatus is set (in-progress).
// Total market:    typeTag="TOTAL",    name="Тотал",  handicap=line
//   runners tags: "OVER" / "UNDER"
// Handicap market: typeTag="HANDICAP", name="Фора",   handicap=homeTeamLine
//   runners tags: "HOME" / "AWAY"
//
// Output (shared with Olimp/Fonbet parsers):
//   { team1, team2, sport, live, link,
//     totals:[{val,over,under}], handicaps:[{param1,kf1,param2,kf2}] }

const BASE = process.env.LEON_BASE_URL || "https://leon.ru";
const API = `${BASE}/api-2/betline`;

const SPORT_LABELS = {
  "Футбол": "Футбол",
  "Хоккей": "Хоккей",
  "Баскетбол": "Баскетбол",
  "Теннис": "Теннис",
  "Волейбол": "Волейбол",
  "Настольный теннис": "Наст. теннис",
};

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json",
};

async function fetchSports() {
  const res = await fetch(`${API}/sports?ctag=ru-RU&flags=urlv2`, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchEvents(sportId) {
  const url = `${API}/events/all?ctag=ru-RU&sport_id=${sportId}&hideClosed=true&flags=reg,urlv2,mm2,rrc,nodup&limit=50`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function parseEvent(ev, sportLabel) {
  if (!ev.liveStatus) return null;
  const home = ev.competitors?.find((c) => c.homeAway === "HOME")?.name;
  const away = ev.competitors?.find((c) => c.homeAway === "AWAY")?.name;
  if (!home || !away) return null;

  const markets = ev.markets || [];
  const totals = extractTotals(markets);
  const handicaps = extractHandicaps(markets);
  if (!totals.length && !handicaps.length) return null;

  return {
    team1: home,
    team2: away,
    sport: sportLabel,
    live: true,
    link: `${BASE}/ru/bets/${ev.url}`,
    totals,
    handicaps,
  };
}

function extractTotals(markets) {
  const byLine = {};
  for (const m of markets) {
    if (m.typeTag !== "TOTAL" || m.name !== "Тотал" || !m.open) continue;
    const line = parseFloat(m.handicap);
    if (isNaN(line) || line <= 0) continue;
    const over = m.runners?.find((r) => r.tags?.includes("OVER"));
    const under = m.runners?.find((r) => r.tags?.includes("UNDER"));
    if (!(over?.price > 1) || !(under?.price > 1)) continue;
    // Keep best odds if multiple markets at same line.
    if (!byLine[line] || over.price + under.price > byLine[line].over + byLine[line].under) {
      byLine[line] = { val: line, over: over.price, under: under.price };
    }
  }
  return Object.values(byLine);
}

function extractHandicaps(markets) {
  const byKey = {};
  for (const m of markets) {
    if (m.typeTag !== "HANDICAP" || !m.open) continue;
    const homeVal = parseFloat(m.handicap);
    if (isNaN(homeVal)) continue;
    const homeR = m.runners?.find((r) => r.tags?.includes("HOME"));
    const awayR = m.runners?.find((r) => r.tags?.includes("AWAY"));
    if (!(homeR?.price > 1) || !(awayR?.price > 1)) continue;
    const key = Math.abs(homeVal).toFixed(2);
    byKey[key] = { param1: homeVal, kf1: homeR.price, param2: -homeVal, kf2: awayR.price };
  }
  return Object.values(byKey);
}

async function getLiveEvents() {
  const sports = await fetchSports();
  const results = await Promise.allSettled(
    sports
      .filter((s) => SPORT_LABELS[s.name])
      .map(async (s) => {
        const data = await fetchEvents(s.id);
        const label = SPORT_LABELS[s.name];
        return (data.events || []).map((ev) => parseEvent(ev, label)).filter(Boolean);
      })
  );
  const events = [];
  for (const r of results) if (r.status === "fulfilled") events.push(...r.value);
  return events;
}

module.exports = { getLiveEvents, extractTotals, extractHandicaps };
