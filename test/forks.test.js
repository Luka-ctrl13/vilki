const { test } = require("node:test");
const assert = require("node:assert");
const server = require("../server");

// Build two books with a known total + handicap surebet on the same fixture,
// with reversed home/away on Olimp to exercise the mirroring logic.
function fixture() {
  const fonbet = [
    {
      team1: "Зенит", team2: "Спартак", sport: "Футбол", live: true, link: "x",
      totals: [{ val: 2.5, over: 2.1, under: 1.8 }],
      handicaps: [{ param1: -1.5, kf1: 2.2, param2: 1.5, kf2: 1.7 }],
    },
  ];
  const olimp = [
    {
      team1: "Spartak", team2: "Zenit", sport: "Футбол", live: true, link: "o",
      totals: [{ val: 2.5, over: 1.85, under: 2.15 }],
      // reversed teams: olimp home = Spartak (xbet team2). For a cross-book fork
      // we want Spartak +1.5 here to pair with Zenit -1.5 @1xBet.
      handicaps: [{ param1: 1.5, kf1: 2.3, param2: -1.5, kf2: 1.6 }],
    },
  ];
  return { fonbet, olimp, leon: [] };
}

test("finds a totals surebet on matching line", () => {
  server._setData(fixture());
  const forks = server.findForks();
  const totals = forks.filter((f) => f.marketType === "total");
  assert.ok(totals.length >= 1);
  // Over@1x 2.1 + Under@Olimp 2.15 -> index < 1 -> profit > 0
  const best = totals.find((f) => f.market.includes("ТБ(2.5) / ТМ(2.5)"));
  assert.ok(best && best.profit > 0);
  // stakes split across the two legs
  const sum = best.legs.reduce((s, l) => s + l.stake, 0);
  assert.ok(Math.abs(sum - 10000) < 5);
});

test("handicap fork respects reversed teams and complementary lines", () => {
  server._setData(fixture());
  const forks = server.findForks();
  const h = forks.filter((f) => f.marketType === "handicap");
  // There should be at least one handicap pairing with complementary lines.
  assert.ok(h.length >= 1);
  for (const f of h) {
    const [a, b] = f.legs;
    assert.ok(Math.abs(a.line + b.line) < 0.1); // complementary
    assert.notEqual(a.book, b.book); // cross-book
  }
});

test("no forks when events do not match", () => {
  server._setData({
    fonbet: [{ team1: "A", team2: "B", totals: [{ val: 2.5, over: 2.1, under: 2.1 }], handicaps: [] }],
    olimp:  [{ team1: "C", team2: "D", totals: [{ val: 2.5, over: 2.1, under: 2.1 }], handicaps: [] }],
    leon:   [],
  });
  assert.equal(server.findForks().length, 0);
});
