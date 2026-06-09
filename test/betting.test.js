const { test } = require("node:test");
const assert = require("node:assert");
const { Coordinator, STATUS } = require("../betting/coordinator");

// Minimal placer stub: ok unless the book is in `failBooks`.
function stubPlacer(failBooks = []) {
  return {
    async place(leg) {
      if (failBooks.includes(leg.book))
        return { ok: false, acceptedOdd: null, message: "rejected" };
      return { ok: true, acceptedOdd: leg.odd, message: "paper fill" };
    },
  };
}

function fork(profit = 3, stake = 1000) {
  return {
    id: "evt|total|2.5|ТБ/ТМ", match: "A — B", market: "ТБ/ТМ", line: 2.5, profit,
    legs: [
      { book: "1xBet", outcome: "ТБ(2.5)", line: 2.5, odd: 2.1, stake: stake / 2 },
      { book: "Olimp", outcome: "ТМ(2.5)", line: 2.5, odd: 2.1, stake: stake / 2 },
    ],
  };
}

test("kill-switch blocks placement", async () => {
  const c = new Coordinator(stubPlacer(), { enabled: false });
  const b = await c.placeFork(fork());
  assert.equal(b.status, STATUS.REJECTED);
  assert.match(b.note, /kill-switch/);
});

test("paper fill simulated when enabled", async () => {
  const c = new Coordinator(stubPlacer(), { enabled: true, mode: "paper", maxStake: 5000 });
  const b = await c.placeFork(fork());
  assert.equal(b.status, STATUS.SIMULATED);
  assert.ok(b.legs.every((l) => l.ok));
});

test("min-profit gate", async () => {
  const c = new Coordinator(stubPlacer(), { enabled: true, minProfit: 5, maxStake: 5000 });
  const b = await c.placeFork(fork(1));
  assert.equal(b.status, STATUS.REJECTED);
  assert.match(b.note, /ниже минимума/);
});

test("max-stake gate", async () => {
  const c = new Coordinator(stubPlacer(), { enabled: true, maxStake: 500 });
  const b = await c.placeFork(fork(3, 1000));
  assert.equal(b.status, STATUS.REJECTED);
});

test("de-dup blocks second placement", async () => {
  const c = new Coordinator(stubPlacer(), { enabled: true, maxStake: 5000 });
  const f = fork();
  assert.equal((await c.placeFork(f)).status, STATUS.SIMULATED);
  assert.equal((await c.placeFork(f)).status, STATUS.REJECTED);
});

test("partial fill flagged UNHEDGED", async () => {
  const c = new Coordinator(stubPlacer(["Olimp"]), { enabled: true, maxStake: 5000 });
  const b = await c.placeFork(fork());
  assert.equal(b.status, STATUS.PARTIAL);
  assert.match(b.note, /НЕ ЗАХЕДЖИРОВАНО/);
});

test("stake override rescales legs", async () => {
  const c = new Coordinator(stubPlacer(), { enabled: true, maxStake: 99999 });
  const b = await c.placeFork(fork(3, 1000), 4000);
  assert.ok(Math.abs(b.totalStake - 4000) < 1);
});
