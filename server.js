const express = require("express");
const cors = require("cors");

const parserFonbet = require("./scrapers/parserFonbet");
const parserOlimp = require("./scrapers/parserOlimp");
const parserLeon = require("./scrapers/parserLeon");
const { sameEvent } = require("./lib/match");
const arb = require("./lib/arb");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_STAKE = Number(process.env.DEFAULT_STAKE || 10000);
const SCAN_MS = Number(process.env.SCAN_MS || 5000);
const MIN_DISPLAY_PROFIT = Number(process.env.MIN_DISPLAY_PROFIT || -3); // show near-forks too

const SOURCES = ["fonbet", "olimp", "leon"];

let liveData = { fonbet: [], olimp: [], leon: [] };
let lastForks = [];
let busy = { fonbet: false, olimp: false, leon: false };

// ----------------------------- scraping loop ------------------------------ //
function startScraping() {
  console.log("Запуск сканера (Fonbet × Olimp × Leon)…");
  const parsers = { fonbet: parserFonbet, olimp: parserOlimp, leon: parserLeon };
  const loop = (key, parser) =>
    setInterval(async () => {
      if (busy[key]) return;
      busy[key] = true;
      try {
        const data = await parser.getLiveEvents();
        if (data && data.length) liveData[key] = data;
      } catch (e) {
        console.error(`Ошибка ${key}:`, e.message);
      } finally {
        busy[key] = false;
      }
    }, SCAN_MS);

  for (const key of SOURCES) loop(key, parsers[key]);
}

// ------------------------------ fork finding ------------------------------ //
function handicapSelections(ev, reversed) {
  const t1 = [], t2 = [];
  for (const h of ev.handicaps || []) {
    t1.push({ line: h.param1, odd: h.kf1 });
    t2.push({ line: h.param2, odd: h.kf2 });
  }
  return reversed ? { team1: t2, team2: t1 } : { team1: t1, team2: t2 };
}

function findForksForPair(eventsA, eventsB, bookA, bookB) {
  const forks = [];
  if (!eventsA.length || !eventsB.length) return forks;

  for (const e1 of eventsA) {
    const cand = eventsB.map((e2) => ({ e2, m: sameEvent(e1, e2) })).find((x) => x.m.match);
    if (!cand) continue;
    const e2 = cand.e2;
    const reversed = cand.m.reversed;
    const match = `${e1.team1} — ${e1.team2}`;

    // ---- Totals ----
    for (const tx of e1.totals || []) {
      for (const to of e2.totals || []) {
        if (Math.abs(tx.val - to.val) > 1e-6) continue;
        addFork(forks, e1, e2, "total", tx.val, match,
          { book: bookA, outcome: `ТБ(${tx.val})`, side: "over",  line: tx.val, odd: tx.over,  link: e1.link },
          { book: bookB, outcome: `ТМ(${to.val})`, side: "under", line: to.val, odd: to.under, link: e2.link });
        addFork(forks, e1, e2, "total", tx.val, match,
          { book: bookA, outcome: `ТМ(${tx.val})`, side: "under", line: tx.val, odd: tx.under, link: e1.link },
          { book: bookB, outcome: `ТБ(${to.val})`, side: "over",  line: to.val, odd: to.over,  link: e2.link });
      }
    }

    // ---- Handicaps ----
    const x = handicapSelections(e1, false);
    const o = handicapSelections(e2, reversed);
    pairHandicaps(forks, e1, e2, match, x.team1, o.team2, bookA, bookB, e1.link, e2.link);
    pairHandicaps(forks, e1, e2, match, o.team1, x.team2, bookB, bookA, e2.link, e1.link);
  }

  return forks;
}

function findForks() {
  const { fonbet, olimp, leon } = liveData;

  const all = [
    ...findForksForPair(fonbet, olimp, "Fonbet", "Olimp"),
    ...findForksForPair(leon,   olimp, "Leon",   "Olimp"),
    ...findForksForPair(fonbet, leon,  "Fonbet", "Leon"),
  ];

  // De-dup across pairs and sort by profit desc.
  const seen = new Set();
  const deduped = [];
  for (const f of all) {
    if (!seen.has(f.id)) { seen.add(f.id); deduped.push(f); }
  }
  return deduped.sort((a, b) => b.profit - a.profit);
}

function pairHandicaps(forks, e1, e2, match, t1Sels, t2Sels, bookA, bookB, linkA, linkB) {
  for (const a of t1Sels) {
    for (const b of t2Sels) {
      if (Math.abs(a.line + b.line) > 0.1) continue;
      const legT1 = { book: bookA, outcome: `Ф1(${a.line})`, side: "home", line: a.line, odd: a.odd, link: linkA };
      const legT2 = { book: bookB, outcome: `Ф2(${b.line})`, side: "away", line: b.line, odd: b.odd, link: linkB };
      addFork(forks, e1, e2, "handicap", a.line, match, legT1, legT2);
    }
  }
}

function addFork(forks, e1, e2, marketType, line, match, legA, legB) {
  const k1 = parseFloat(legA.odd), k2 = parseFloat(legB.odd);
  if (!arb.isValidOdd(k1) || !arb.isValidOdd(k2)) return;
  const profit = arb.profitPct(k1, k2);
  if (profit < MIN_DISPLAY_PROFIT) return;

  const split = arb.splitStakes(k1, k2, DEFAULT_STAKE);
  legA = { ...legA, odd: k1, stake: split.stake1, stakePct: Math.round((100 / k1 / arb.arbIndex(k1, k2)) * 10) / 10 };
  legB = { ...legB, odd: k2, stake: split.stake2, stakePct: Math.round((100 / k2 / arb.arbIndex(k1, k2)) * 10) / 10 };

  const id = `${match}|${marketType}|${line}|${legA.book}|${legB.book}|${legA.outcome}/${legB.outcome}`;
  if (forks.some((f) => f.id === id)) return;

  forks.push({
    id,
    match,
    sport: e1.sport || e2.sport,
    marketType,
    market: `${legA.outcome} / ${legB.outcome}`,
    line,
    profit: Math.round(profit * 100) / 100,
    index: Math.round(arb.arbIndex(k1, k2) * 1e4) / 1e4,
    legs: [legA, legB],
  });
}

// --------------------------------- API ------------------------------------ //
app.get("/api/forks", (req, res) => {
  lastForks = findForks();
  res.json(lastForks);
});

app.get("/api/all-events", (req, res) =>
  res.json({
    fonbetCount: liveData.fonbet.length,
    olimpCount:  liveData.olimp.length,
    leonCount:   liveData.leon.length,
    fonbet: liveData.fonbet,
    olimp:  liveData.olimp,
    leon:   liveData.leon,
  })
);

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Сервер: http://localhost:${PORT}`);
    startScraping();
  });
}

module.exports = { app, findForks, handicapSelections, _setData: (d) => (liveData = d) };
