// Thin API client for the FastAPI backend.

const BASE = import.meta.env.VITE_API_BASE || "";

async function req(path, { params = {}, method = "GET", body } = {}) {
  const url = new URL(BASE + path, window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url.pathname + url.search, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

export const fetchSurebets = (params) => req("/api/surebets", { params });
export const fetchHealth = () => req("/api/health");

export const fetchBettingStatus = () => req("/api/betting/status");
export const fetchBets = () => req("/api/betting/bets");
export const toggleBetting = (enabled) =>
  req("/api/betting/toggle", { method: "POST", body: { enabled } });
export const placeBet = (surebet_id, stake) =>
  req("/api/betting/place", { method: "POST", body: { surebet_id, stake } });
