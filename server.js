const express = require("express");
const cors = require("cors");

const parserFonbet = require("./scrapers/parserFonbet");
const parserOlimp = require("./scrapers/parserOlimp");
const { sameEvent } = require("./lib/match");
const arb = require("./lib/arb");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_STAKE = Number(process.env.DEFAULT_STAKE || 10000);
const SCAN_MS = Number(process.env.SCAN_MS || 5000);
const MIN_DISPLAY_PROFIT = Number(process.env.MIN_DISPLAY_PROFIT || 0); // show forks >= this %

const BOOK_A = "Fonbet";
const BOOK_B = "Olimp";

let liveData = { fonbet: [], olimp: [] };
let lastForks = [];
let busy = { fonbet: false, olimp: false };

// ----------------------------- scraping loop ------------------------------ //
function startScraping() {
  console.log("Запуск сканера (Fonbet × Olimp)…");
  const loop = (key, parser) =>
    setInterval(async () => {
      if (busy[key]) return;
      busy[key] = true;
      try {
        const data = await parser.getLiveEvents();
        if (data && data.length) liveData[key] = data; // keep old data on null/empty
      } catch (e) {
        console.error(`Ошибка ${key}:`, e.message);
      } finally {
        busy[key] = false;
      }
    }, SCAN_MS);

  loop("fonbet", parserFonbet);
  loop("olimp", parserOlimp);
}

// ------------------------------ fork finding ------------------------------ //
// Express each event's handicaps in book-A team perspective: selections for
// team1 and team2 with their own line and odd.
function handicapSelections(ev, reversed) {
  const t1 = [], t2 = [];
  for (const h of ev.handicaps || []) {
    t1.push({ line: h.param1, odd: h.kf1 });
    t2.push({ line: h.param2, odd: h.kf2 });
  }
  return reversed ? { team1: t2, team2: t1 } : { team1: t1, team2: t2 };
}

function findForks() {
  const forks = [];
  const a = liveData.fonbet, b = liveData.olimp;
  if (!a.length || !b.length) return [];

  for (const e1 of a) {
    const cand = b.map((e2) => ({ e2, m: sameEvent(e1, e2) })).find((x) => x.m.match);
    if (!cand) continue;
    const e2 = cand.e2;
    const reversed = cand.m.reversed;
    const match = `${e1.team1} — ${e1.team2}`;

    // ---- Totals: Over@A(val) + Under@B(val) for equal lines ----
    for (const tx of e1.totals || []) {
      for (const to of e2.totals || []) {
        if (Math.abs(tx.val - to.val) > 1e-6) continue;
        addFork(forks, e1, e2, "total", tx.val, match,
          { book: BOOK_A, outcome: `ТБ(${tx.val})`, side: "over", line: tx.val, odd: tx.over, link: e1.link },
          { book: BOOK_B, outcome: `ТМ(${to.val})`, side: "under", line: to.val, odd: to.under, link: e2.link });
        addFork(forks, e1, e2, "total", tx.val, match,
          { book: BOOK_A, outcome: `ТМ(${tx.val})`, side: "under", line: tx.val, odd: tx.under, link: e1.link },
          { book: BOOK_B, outcome: `ТБ(${to.val})`, side: "over", line: to.val, odd: to.over, link: e2.link });
      }
    }

    // ---- Handicaps: team1 +L @A and team2 -L @B (complementary lines) ----
    const x = handicapSelections(e1, false);
    const o = handicapSelections(e2, reversed);
    pairHandicaps(forks, e1, e2, match, x.team1, o.team2, BOOK_A, BOOK_B, e1.link, e2.link);
    pairHandicaps(forks, e1, e2, match, o.team1, x.team2, BOOK_B, BOOK_A, e2.link, e1.link);
  }

  return forks.sort((f1, f2) => f2.profit - f1.profit);
}

// team1 selections at book A vs team2 selections at book B, complementary lines.
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

  const id = `${match}|${marketType}|${line}|${legA.outcome}/${legB.outcome}`;
  if (forks.some((f) => f.id === id)) return; // de-dup within one scan

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
    olimpCount: liveData.olimp.length,
    fonbet: liveData.fonbet,
    olimp: liveData.olimp,
  })
);

// Boot the server + scrapers only when run directly (not when imported by tests).
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Сервер: http://localhost:${PORT}`);
    startScraping();
  });
}

module.exports = { app, findForks, handicapSelections, _setData: (d) => (liveData = d) };
