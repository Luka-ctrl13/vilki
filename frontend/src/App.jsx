import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchBets,
  fetchBettingStatus,
  fetchHealth,
  fetchSurebets,
  placeBet,
  toggleBetting,
} from "./api.js";
import SurebetCard from "./SurebetCard.jsx";
import BettingBar from "./BettingBar.jsx";

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

  // Betting automation.
  const [betting, setBetting] = useState(null);
  const [bets, setBets] = useState([]);

  const loadBetting = useCallback(async () => {
    try {
      const [st, b] = await Promise.all([fetchBettingStatus(), fetchBets()]);
      setBetting(st);
      setBets(b.bets || []);
    } catch {
      /* betting endpoints optional */
    }
  }, []);

  const onToggleBetting = useCallback(async (enabled) => {
    setBetting(await toggleBetting(enabled));
  }, []);

  const onPlace = useCallback(
    async (id, amount) => {
      const bet = await placeBet(id, amount);
      loadBetting();
      return bet;
    },
    [loadBetting]
  );

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
    loadBetting();
  }, [load, loadBetting]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      load();
      loadBetting();
    }, 10000);
    return () => clearInterval(id);
  }, [autoRefresh, load, loadBetting]);

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
      {health && (
        <div className="banner info">
          Источники:{" "}
          {health.parsers?.map((p) => (
            <span key={p.name} className={`src ${p.enabled ? "on" : "off"}`}>
              <code>{p.name}</code> {p.enabled ? "вкл" : "выкл"}
            </span>
          ))}
          {health.offers === 0 &&
            " — букмекеры не отдали данные (возможна геоблокировка IP). Запусти бэкенд из разрешённого региона или включи DEMO_FALLBACK=1."}
        </div>
      )}

      <BettingBar status={betting} bets={bets} onToggle={onToggleBetting} />

      <main className="grid">
        {surebets.length === 0 && !loading && (
          <div className="empty">Вилок по текущим фильтрам нет. Попробуй снизить мин. прибыль.</div>
        )}
        {surebets.map((s) => (
          <SurebetCard
            key={s.id}
            surebet={s}
            stake={stake}
            canBet={!!betting?.enabled}
            onPlaced={onPlace}
          />
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
