const { test } = require("node:test");
const assert = require("node:assert");
const arb = require("../lib/arb");

test("valid odd bounds", () => {
  assert.equal(arb.isValidOdd(2.0), true);
  assert.equal(arb.isValidOdd(1.0), false);
  assert.equal(arb.isValidOdd(40), false);
  assert.equal(arb.isValidOdd("x"), false);
});

test("surebet index and profit", () => {
  // 2.10 / 2.10 -> index ~0.952, profit ~5%
  assert.ok(Math.abs(arb.arbIndex(2.1, 2.1) - 0.95238) < 1e-4);
  assert.ok(Math.abs(arb.profitPct(2.1, 2.1) - 5.0) < 0.01);
});

test("no surebet -> negative profit", () => {
  assert.ok(arb.profitPct(1.9, 1.9) < 0);
});

test("stake split equalizes returns and locks profit", () => {
  const s = arb.splitStakes(2.1, 2.1, 1000);
  assert.ok(Math.abs(s.stake1 + s.stake2 - 1000) < 0.5);
  assert.ok(Math.abs(s.return1 - s.return2) < 0.5);
  assert.ok(s.return1 > 1000); // guaranteed profit
  assert.ok(s.profit > 0);
});
