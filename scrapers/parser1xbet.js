// 1xBet live parser — drives a stealth browser, but reads the site's own JSON
// LiveFeed API from inside the authenticated page (page.evaluate(fetch)) instead
// of scraping rendered DOM text. This is far more reliable (exact odds & lines)
// and reuses the real browser session, so it passes anti-bot the same way a user
// would.
//
// NOTE: 1xBet geo-blocks data-center IPs (redirect to /block). Run from an
// allowed region. Endpoints/codes below are the widely-used LiveFeed values;
// if a mirror numbers them differently, fix EVENT_CODES — one place.
//
// Output shape (shared with the Olimp parser):
//   { team1, team2, sport, live, link,
//     totals:    [{ val, over, under }, ...],
//     handicaps: [{ param1, kf1, param2, kf2 }, ...] }   // param1 = home line

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const { KnownDevices } = require("puppeteer");

const BASE = process.env.ONEXBET_BASE_URL || "https://1xbet.kz";
const PARTNER = process.env.ONEXBET_PARTNER || "159";
const MAX_GAMES_PER_SPORT = Number(process.env.ONEXBET_MAX_GAMES || 12);

// 1xBet sportId -> our sport label.
const SPORTS = { 1: "Футбол", 2: "Хоккей", 3: "Баскетбол", 4: "Теннис", 10: "Наст. теннис" };

// GetGameZip event `T` -> [market, side]. Line is in field `P`.
const EVENT_CODES = {
  9: ["total", "over"],
  10: ["total", "under"],
  7: ["handicap", "home"],
  8: ["handicap", "away"],
};

let browser = null;
let page = null;

async function ensureBrowser() {
  if (browser && browser.isConnected() && page && !page.isClosed()) return;
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: process.env.HEADLESS === "new" ? "new" : false,
      userDataDir: process.env.ONEXBET_PROFILE || "./.profile-1xbet", // persist session for betting
      args: [
        "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
        "--disable-features=IsolateOrigins,site-per-process", "--lang=ru-RU,ru",
      ],
    });
    browser.on("disconnected", () => { browser = null; page = null; });
    page = await browser.newPage();
    await page.emulate(KnownDevices["iPhone X"]);
    await page.setExtraHTTPHeaders({ "Accept-Language": "ru-RU,ru;q=0.9" });
  }
  if (!page || page.isClosed()) page = await browser.newPage();
  if (!page.url().includes(BASE.replace(/^https?:\/\//, ""))) {
    try { await page.goto(`${BASE}/ru/live`, { waitUntil: "domcontentloaded", timeout: 60000 }); } catch (e) {}
  }
}

// Fetch a JSON endpoint from inside the page (same-origin, real session).
async function apiGet(path) {
  return page.evaluate(async (url) => {
    try {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }, path);
}

async function listGames(sportId) {
  const qs =
    `sports=${sportId}&count=30&lng=ru&mode=4&country=1&partner=${PARTNER}` +
    `&top=false&virtualSports=true&noFilterBlockEvent=true`;
  const data = await apiGet(`${BASE}/LiveFeed/Get1x2_VZip?${qs}`);
  const games = [];
  for (const g of data?.Value || []) {
    if (g.I && g.O1 && g.O2) games.push({ id: g.I, team1: g.O1, team2: g.O2 });
  }
  return games.slice(0, MAX_GAMES_PER_SPORT);
}

async function gameMarkets(gameId) {
  const qs =
    `id=${gameId}&lng=ru&country=1&partner=${PARTNER}&grMode=4` +
    `&isSubGames=true&GroupEvents=true&countevents=250&marketType=1`;
  const data = await apiGet(`${BASE}/LiveFeed/GetGameZip?${qs}`);
  return data?.Value || null;
}

// Pure: turn one GetGameZip Value into our event shape. Exported for testing.
function parseGame(value, team1, team2, sport) {
  const events = collectEvents(value);
  const totalsByLine = {};
  const hcapByKey = {};

  for (const e of events) {
    const code = EVENT_CODES[e.T];
    const k = e.C;
    if (!code || !(k > 1) || e.P === undefined || e.P === null) continue;
    const line = parseFloat(e.P);
    if (isNaN(line)) continue;
    const [market, side] = code;
    if (market === "total") {
      (totalsByLine[line] ||= { val: line })[side] = k;
    } else {
      const key = Math.abs(line).toFixed(2);
      const slot = (hcapByKey[key] ||= {});
      if (side === "home") { slot.param1 = line; slot.kf1 = k; }
      else { slot.param2 = line; slot.kf2 = k; }
    }
  }

  return {
    team1, team2, sport, live: true,
    link: `${BASE}/ru/live/${value?.I ?? ""}`,
    totals: Object.values(totalsByLine).filter((t) => t.over && t.under)
      .map((t) => ({ val: t.val, over: t.over, under: t.under })),
    handicaps: Object.values(hcapByKey).filter((h) => h.kf1 && h.kf2),
  };
}

// Recursively gather event dicts (carry a `T`) from the nested GE/E tree.
function collectEvents(node, out = []) {
  if (Array.isArray(node)) {
    for (const v of node) collectEvents(v, out);
  } else if (node && typeof node === "object") {
    if ("T" in node && ("C" in node || "P" in node)) out.push(node);
    for (const v of Object.values(node)) collectEvents(v, out);
  }
  return out;
}

async function getLiveEvents() {
  try {
    await ensureBrowser();
    const all = [];
    for (const [sid, name] of Object.entries(SPORTS)) {
      const games = await listGames(Number(sid));
      for (const g of games) {
        const val = await gameMarkets(g.id);
        if (val) all.push(parseGame(val, g.team1, g.team2, name));
      }
    }
    return all;
  } catch (err) {
    const msg = err.message || "";
    if (/destroyed|detached|closed/.test(msg) && browser && !browser.isConnected()) browser = null;
    return null; // keep previous data on transient errors
  }
}

module.exports = { getLiveEvents, parseGame, collectEvents };
