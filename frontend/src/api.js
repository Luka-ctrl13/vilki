// Thin API client for the FastAPI backend.

const BASE = import.meta.env.VITE_API_BASE || "";

async function get(path, params = {}) {
  const url = new URL(BASE + path, window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url.pathname + url.search);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

export const fetchSurebets = (opts) => get("/api/surebets", opts);
export const fetchHealth = () => get("/api/health");
