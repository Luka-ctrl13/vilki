import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchHealth, fetchSurebets } from "./api.js";
import SurebetCard from "./SurebetCard.jsx";

const SPORTS = [
  { key: "", label: "Все виды спорта" },
  { key: "soccer", label: "Футбол" },
  { key: "tennis", label: "Теннис" },
  { key: "basketball", label: "Баскетбол" },
  { key: "hockey", label: "Хоккей" },
  { key: "table_tennis", label: "Наст. теннис" },
];

export default function App() {
  const [surebets, setSurebets] = useState([]);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Filters / inputs.
  const [sport, setSport] = useState("");
  const [minProfit, setMinProfit] = useState(0);
  const [liveOnly, setLiveOnly] = useState(false);
  const [stake, setStake] = useState(1000);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sb, h] = await Promise.all([
        fetchSurebets({ sport, min_profit: minProfit, live_only: liveOnly, stake }),
        fetchHealth(),
      ]);
      setSurebets(sb.surebets || []);
      setHealth({ ...h, last_run: sb.last_run });
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [sport, minProfit, liveOnly, stake]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const bestProfit = useMemo(
    () => (surebets.length ? Math.max(...surebets.map((s) => s.profit_pct)) : 0),
    [surebets]
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⚡</span>
          <div>
            <h1>Vilki</h1>
            <p className="tagline">Поиск вилок по live-кэфам</p>
          </div>
        </div>
        <div className="stats">
          <Stat label="Вилок найдено" value={surebets.length} />
          <Stat label="Лучшая прибыль" value={`${bestProfit.toFixed(2)}%`} highlight />
          <Stat label="Офферов" value={health?.offers ?? "—"} />
        </div>
      </header>

      <section className="controls">
        <label>
          Спорт
          <select value={sport} onChange={(e) => setSport(e.target.value)}>
            {SPORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Мин. прибыль: <b>{minProfit}%</b>
          <input
            type="range"
            min="0"
            max="10"
            step="0.5"
            value={minProfit}
            onChange={(e) => setMinProfit(Number(e.target.value))}
          />
        </label>

        <label>
          Банк (₽)
          <input
            type="number"
            min="1"
            value={stake}
            onChange={(e) => setStake(Number(e.target.value) || 0)}
          />
        </label>

        <label className="checkbox">
          <input type="checkbox" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} />
          Только live
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Автообновление
        </label>

        <button className="refresh" onClick={load} disabled={loading}>
          {loading ? "Обновляю…" : "Обновить"}
        </button>
      </section>

      {error && <div className="banner error">Ошибка: {error}</div>}
      {health && !health.parsers?.some((p) => p.name === "the_odds_api" && p.enabled) && (
        <div className="banner info">
          Реальный источник <code>the_odds_api</code> выключен — нет ключа. Сейчас данные с
          демо-парсера. Добавь <code>THE_ODDS_API_KEY</code> в env, чтобы включить live-кэфы реальных
          букмекеров.
        </div>
      )}

      <main className="grid">
        {surebets.length === 0 && !loading && (
          <div className="empty">Вилок по текущим фильтрам нет. Попробуй снизить мин. прибыль.</div>
        )}
        {surebets.map((s) => (
          <SurebetCard key={`${s.event_key}:${s.market}`} surebet={s} />
        ))}
      </main>

      <footer className="foot">
        {health?.last_run && (
          <span>Обновлено: {new Date(health.last_run).toLocaleTimeString()}</span>
        )}
      </footer>
    </div>
  );
}

function Stat({ label, value, highlight }) {
  return (
    <div className={`stat ${highlight ? "stat-hl" : ""}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
