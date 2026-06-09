// Renders one detected surebet (totals / handicap): event, line, profit, the
// stake split per leg, and a one-click "place bet" button.
import { useState } from "react";

const SPORT_ICON = {
  soccer: "⚽",
  tennis: "🎾",
  basketball: "🏀",
  hockey: "🏒",
  table_tennis: "🏓",
  volleyball: "🏐",
};

const MARKET_LABEL = { totals: "Тотал", handicap: "Фора" };

function outcomeLabel(outcome, line) {
  const l = line == null ? "" : ` ${line > 0 ? "+" : ""}${line}`;
  if (outcome === "Over") return `Больше ${line}`;
  if (outcome === "Under") return `Меньше ${line}`;
  if (outcome === "H1") return `Ф1${l}`;
  if (outcome === "H2") return `Ф2${l}`;
  return outcome;
}

const STATUS_STYLE = {
  SIMULATED: { cls: "ok", text: "Симуляция: ставки проставлены (paper)" },
  PLACED: { cls: "ok", text: "Ставки проставлены" },
  PARTIAL: { cls: "warn", text: "⚠ Исполнена только часть — позиция не захеджирована!" },
  REJECTED: { cls: "bad", text: "Отклонено" },
  FAILED: { cls: "bad", text: "Ошибка" },
};

export default function SurebetCard({ surebet: s, stake, canBet, onPlaced }) {
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState(null);
  const start = s.start_time ? new Date(s.start_time) : null;

  async function place() {
    setPlacing(true);
    try {
      const bet = await onPlace();
      setResult(bet);
    } catch (e) {
      setResult({ status: "FAILED", note: e.message, legs: [] });
    } finally {
      setPlacing(false);
    }
  }
  async function onPlace() {
    return onPlaced(s.id, stake);
  }

  const st = result && (STATUS_STYLE[result.status] || STATUS_STYLE.FAILED);

  return (
    <article className="card">
      <div className="card-head">
        <span className="sport">{SPORT_ICON[s.sport] || "🎯"} {s.sport}</span>
        <span className="market">
          {MARKET_LABEL[s.market] || s.market} {s.line > 0 ? "+" : ""}{s.line}
        </span>
        {s.is_live ? <span className="live">● LIVE</span> : start && <span className="time">{start.toLocaleString()}</span>}
        <span className="profit">+{s.profit_pct.toFixed(2)}%</span>
      </div>

      <h3 className="teams">
        {s.home} <span className="vs">—</span> {s.away}
      </h3>

      <div className="legs">
        {s.legs.map((leg, i) => (
          <div className="leg" key={i}>
            <div className="leg-outcome">{outcomeLabel(leg.outcome, leg.line)}</div>
            <div className="leg-book">{leg.bookmaker}</div>
            <div className="leg-odd">{leg.odd.toFixed(2)}</div>
            <div className="leg-stake">
              {leg.stake.toFixed(0)} ₽<span className="leg-pct">{leg.stake_pct.toFixed(1)}%</span>
            </div>
          </div>
        ))}
      </div>

      <div className="card-foot">
        <span>Индекс: {s.arb_index.toFixed(4)}</span>
        <span>{s.bookmakers.join(" + ")}</span>
        <button className="bet-btn" onClick={place} disabled={placing || !canBet}
          title={canBet ? "Проставить обе ставки" : "Включите автоставки сверху"}>
          {placing ? "Ставлю…" : "Поставить"}
        </button>
      </div>

      {st && (
        <div className={`bet-result ${st.cls}`}>
          <b>{st.text}</b>
          {result.note && <div className="bet-note">{result.note}</div>}
          {result.legs?.map((l, i) => (
            <div key={i} className="bet-leg">
              {l.bookmaker}: {l.ok ? "✓" : "✗"} {l.message}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
