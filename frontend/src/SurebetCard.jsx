// Renders one detected surebet: the event, profit, and the stake split per leg.

const SPORT_ICON = {
  soccer: "⚽",
  tennis: "🎾",
  basketball: "🏀",
  hockey: "🏒",
  table_tennis: "🏓",
  baseball: "⚾",
  am_football: "🏈",
};

const OUTCOME_LABEL = { 1: "П1", X: "Ничья", 2: "П2" };

export default function SurebetCard({ surebet: s }) {
  const start = s.start_time ? new Date(s.start_time) : null;
  return (
    <article className="card">
      <div className="card-head">
        <span className="sport">{SPORT_ICON[s.sport] || "🎯"} {s.sport}</span>
        {s.is_live ? (
          <span className="live">● LIVE</span>
        ) : (
          start && <span className="time">{start.toLocaleString()}</span>
        )}
        <span className="profit">+{s.profit_pct.toFixed(2)}%</span>
      </div>

      <h3 className="teams">
        {s.home} <span className="vs">—</span> {s.away}
      </h3>

      <div className="legs">
        {s.legs.map((leg, i) => (
          <div className="leg" key={i}>
            <div className="leg-outcome">{OUTCOME_LABEL[leg.outcome] || leg.outcome}</div>
            <div className="leg-book">{leg.bookmaker}</div>
            <div className="leg-odd">{leg.odd.toFixed(2)}</div>
            <div className="leg-stake">
              {leg.link ? (
                <a href={leg.link} target="_blank" rel="noreferrer">
                  {leg.stake.toFixed(0)} ₽
                </a>
              ) : (
                <>{leg.stake.toFixed(0)} ₽</>
              )}
              <span className="leg-pct">{leg.stake_pct.toFixed(1)}%</span>
            </div>
          </div>
        ))}
      </div>

      <div className="card-foot">
        <span>Банк: {s.total_stake.toFixed(0)} ₽</span>
        <span>Индекс: {s.arb_index.toFixed(4)}</span>
        <span>{s.bookmakers.length} букм.</span>
      </div>
    </article>
  );
}
