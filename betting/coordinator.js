// Bet automation coordinator: risk gates + placing both legs + history.
//
// Safety posture (same as the rest of the project):
//   * PAPER mode is the default — fills are simulated, no money moves.
//   * REAL mode places via betting/placer.js by clicking in your logged-in
//     browser session. It is opt-in and gated by a master kill-switch.
//   * Risk controls run before any placement: kill-switch, min-profit,
//     max-stake, de-duplication.
//   * Partial fills (one leg in, one rejected) are the real danger of arb
//     automation — they are flagged PARTIAL and surfaced, never swallowed.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATUS = {
  SIMULATED: "SIMULATED",
  PLACED: "PLACED",
  PARTIAL: "PARTIAL",
  REJECTED: "REJECTED",
};

class Coordinator {
  constructor(placer, risk = {}) {
    this.placer = placer;
    this.risk = {
      enabled: false,
      mode: process.env.BETTING_MODE === "real" ? "real" : "paper",
      minProfit: Number(process.env.BETTING_MIN_PROFIT || 0.5),
      maxStake: Number(process.env.BETTING_MAX_STAKE || 5000),
      ...risk,
    };
    this.history = [];
    this.placedIds = new Set();
    this._busy = false;
  }

  status() {
    return {
      ...this.risk,
      placedCount: this.placedIds.size,
      historyCount: this.history.length,
      placer: this.placer.status ? this.placer.status() : {},
    };
  }

  _reject(fork, reason) {
    return this._record({
      forkId: fork.id, event: fork.match, market: fork.market, line: fork.line,
      status: STATUS.REJECTED, totalStake: 0, expectedProfit: fork.profit, legs: [], note: reason,
    });
  }

  _checkRisk(fork, stake) {
    if (!this.risk.enabled) return "автоставки выключены (kill-switch)";
    if (this.placedIds.has(fork.id)) return "уже ставили на эту вилку";
    if (Number(fork.profit) < this.risk.minProfit)
      return `прибыль ${fork.profit}% ниже минимума ${this.risk.minProfit}%`;
    if (stake > this.risk.maxStake) return `ставка ${stake} больше лимита ${this.risk.maxStake}`;
    return null;
  }

  async placeFork(fork, totalStake) {
    const stake = totalStake || fork.legs.reduce((s, l) => s + (l.stake || 0), 0);
    if (this._busy) return this._reject(fork, "занято другой ставкой, повторите");
    this._busy = true;
    try {
      const reason = this._checkRisk(fork, stake);
      if (reason) return this._reject(fork, reason);

      // Rescale stakes if the operator overrode the bankroll.
      const base = fork.legs.reduce((s, l) => s + (l.stake || 0), 0) || 1;
      const factor = stake / base;
      const legs = [];
      for (const leg of fork.legs) {
        const legStake = Math.round((leg.stake || 0) * factor * 100) / 100;
        const res = await this.placer.place({ ...leg, stake: legStake }, this.risk.mode);
        legs.push({ book: leg.book, outcome: leg.outcome, line: leg.line, stake: legStake,
          requestedOdd: leg.odd, acceptedOdd: res.acceptedOdd, ok: res.ok, message: res.message });
      }

      const status = this._statusFrom(legs);
      if (status !== STATUS.REJECTED) this.placedIds.add(fork.id);
      return this._record({
        forkId: fork.id, event: fork.match, market: fork.market, line: fork.line,
        status, totalStake: Math.round(legs.reduce((s, l) => s + l.stake, 0) * 100) / 100,
        expectedProfit: fork.profit, legs, note: this._note(status),
      });
    } finally {
      this._busy = false;
    }
  }

  _statusFrom(legs) {
    const oks = legs.map((l) => l.ok);
    if (oks.every(Boolean))
      return legs.every((l) => l.message === "paper fill") ? STATUS.SIMULATED : STATUS.PLACED;
    if (oks.some(Boolean)) return STATUS.PARTIAL;
    return STATUS.REJECTED;
  }

  _note(status) {
    if (status === STATUS.PARTIAL)
      return "⚠ НЕ ЗАХЕДЖИРОВАНО: одна нога прошла, вторая нет — разрулите вручную!";
    if (status === STATUS.REJECTED) return "все ноги не прошли (см. сообщения)";
    return "";
  }

  _record(bet) {
    bet.createdAt = new Date().toISOString();
    this.history.unshift(bet);
    this.history = this.history.slice(0, 200);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, "bets.json"), JSON.stringify(this.history, null, 2));
    } catch (e) {}
    return bet;
  }
}

module.exports = { Coordinator, STATUS };
