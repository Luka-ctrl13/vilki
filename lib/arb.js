// Arbitrage math for a 2-outcome market (totals Over/Under, handicaps Ф1/Ф2).
//
// Decimal odd k implies probability 1/k. Two opposite outcomes priced at k1, k2
// across two books form a surebet when 1/k1 + 1/k2 < 1. Stakes are split so both
// outcomes return the same amount, locking the profit in.

const MAX_ODD = 35;   // ignore obviously broken / extreme odds
const MIN_ODD = 1.01;

function isValidOdd(k) {
  return typeof k === "number" && isFinite(k) && k > MIN_ODD && k <= MAX_ODD;
}

// Index = sum of implied probabilities. < 1 => surebet.
function arbIndex(k1, k2) {
  return 1 / k1 + 1 / k2;
}

function profitPct(k1, k2) {
  return (1 / arbIndex(k1, k2) - 1) * 100;
}

// Split `total` stake between the two legs to equalize the return.
function splitStakes(k1, k2, total) {
  const idx = arbIndex(k1, k2);
  const s1 = (total * (1 / k1)) / idx;
  const s2 = (total * (1 / k2)) / idx;
  return {
    stake1: Math.round(s1 * 100) / 100,
    stake2: Math.round(s2 * 100) / 100,
    return1: Math.round(s1 * k1 * 100) / 100,
    return2: Math.round(s2 * k2 * 100) / 100,
    profit: Math.round((s1 * k1 - total) * 100) / 100,
  };
}

module.exports = { isValidOdd, arbIndex, profitPct, splitStakes, MAX_ODD, MIN_ODD };
