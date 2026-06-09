// Betting automation control bar: mode, kill-switch, executor status, history.

export default function BettingBar({ status, bets, onToggle }) {
  if (!status) return null;
  const real = status.mode === "real";

  return (
    <section className="betbar">
      <div className="betbar-main">
        <div className={`mode ${real ? "real" : "paper"}`}>
          {real ? "РЕАЛЬНЫЕ СТАВКИ" : "СИМУЛЯЦИЯ (paper)"}
        </div>

        <label className="switch">
          <input
            type="checkbox"
            checked={status.enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>Автоставки {status.enabled ? "включены" : "выключены"}</span>
        </label>

        <span className="betbar-meta">
          мин. прибыль {status.min_profit_pct}% · макс. ставка {status.max_stake_per_bet} ₽ ·
          поставлено {status.placed_count}
        </span>

        <div className="executors">
          {status.executors
            .filter((e) => e.bookmaker === "Olimp" || e.bookmaker === "1xbet")
            .map((e) => (
              <span key={e.bookmaker} className={`exec ${e.configured ? "ok" : "no"}`}>
                {e.bookmaker}: {e.real ? (e.configured ? "готов" : "нет сессии") : "paper"}
              </span>
            ))}
        </div>
      </div>

      {real && status.enabled && (
        <div className="betbar-warn">
          ⚠ Включён режим реальных ставок. Проверь риск-лимиты. Партиальное исполнение (одна нога
          прошла, вторая нет) оставляет незахеджированную позицию.
        </div>
      )}

      {bets?.length > 0 && (
        <details className="bets-history">
          <summary>История ставок ({bets.length})</summary>
          <div className="bets-list">
            {bets.slice(0, 20).map((b, i) => (
              <div key={i} className={`bet-row ${b.status.toLowerCase()}`}>
                <span className="bet-status">{b.status}</span>
                <span className="bet-event">{b.event}</span>
                <span className="bet-mk">
                  {b.market} {b.line ?? ""}
                </span>
                <span className="bet-stake">{b.total_stake} ₽</span>
                <span className="bet-prof">+{b.expected_profit_pct?.toFixed?.(2)}%</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
