"""Olimp (olimpbet.kz) live-odds parser — totals and handicaps only.

Reverse-engineered from the site's own public JSON API (no auth needed for the
betting line, only a platform header):

    GET https://olimpbet.kz/api/v2/events
        ?locale=ru&sport-ids=100&live=true&page-size=N&statuses=OPEN&statuses=TRADING
    headers: x-platform: web-desktop

Markets we read (verified against live data):
    1003 TOTAL    -> outcome 1006 = Under (Меньше), 1007 = Over (Больше)
                     each probability carries PARAMETER_VALUE = the line, e.g. "2.5"
    1004 HANDICAP -> outcome 1008 = Ф1 (home), 1009 = Ф2 (away)
                     PARAMETER_VALUE is the handicap, e.g. home "+1.0" / away "-1.0"

A market can list several lines at once (1.5, 2.5, 3.5 …); we emit one
selection per (side, line). Handicap lines are normalized to the home team's
perspective so they line up with other bookmakers (home +1.0 and away -1.0
both map to home line -1.0 → see base.normalize_handicap).
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime

import httpx

from app.models import BookmakerOffer, Selection
from app.parsers.base import BaseParser, make_event_key

BASE = os.getenv("OLIMP_BASE_URL", "https://olimpbet.kz")

SPORT_BUCKETS = {
    100: "soccer",
    101: "tennis",
    102: "basketball",
    103: "hockey",
    104: "volleyball",
    110: "table_tennis",
}

# Market 1003 = TOTAL. outcomeTypeId -> side.
TOTAL_MARKET = 1003
TOTAL_SIDES = {1006: "Under", 1007: "Over"}

# Market 1004 = HANDICAP. outcomeTypeId -> side (home / away).
HANDICAP_MARKET = 1004
HANDICAP_SIDES = {1008: "H1", 1009: "H2"}


def _param_value(probability: dict) -> float | None:
    """Pull PARAMETER_VALUE (the line) out of a probability's parameters."""
    for p in probability.get("parameters", []) or []:
        if p.get("type") == "PARAMETER_VALUE":
            try:
                return float(p.get("value"))
            except (TypeError, ValueError):
                return None
    return None


class OlimpParser(BaseParser):
    name = "olimp"

    def __init__(self, page_size: int = 40, timeout: float = 15.0, concurrency: int = 3):
        self.page_size = page_size
        self.timeout = timeout
        self._sem = asyncio.Semaphore(concurrency)
        self.enabled = os.getenv("OLIMP_ENABLED", "1") != "0"

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "Accept": "application/json",
            "x-platform": "web-desktop",
            "Referer": f"{BASE}/live",
        }

    async def fetch(self) -> list[BookmakerOffer]:
        if not self.enabled:
            return []
        async with httpx.AsyncClient(timeout=self.timeout, headers=self._headers) as client:
            tasks = [self._fetch_sport(client, sid, b) for sid, b in SPORT_BUCKETS.items()]
            results = await asyncio.gather(*tasks, return_exceptions=True)
        offers: list[BookmakerOffer] = []
        for r in results:
            if isinstance(r, list):
                offers.extend(r)
        return offers

    async def _fetch_sport(
        self, client: httpx.AsyncClient, sport_id: int, bucket: str
    ) -> list[BookmakerOffer]:
        params = [
            ("locale", "ru"),
            ("sport-ids", str(sport_id)),
            ("live", "true"),
            ("page-size", str(self.page_size)),
            ("statuses", "OPEN"),
            ("statuses", "TRADING"),
        ]
        async with self._sem:
            resp = await client.get(f"{BASE}/api/v2/events", params=params)
        if resp.status_code != 200:
            import logging

            logging.getLogger("parsers").warning("olimp sport %s -> HTTP %s", sport_id, resp.status_code)
            return []
        return self._parse(resp.json(), bucket)

    def _parse(self, payload: dict, bucket: str) -> list[BookmakerOffer]:
        offers: list[BookmakerOffer] = []
        for ev in payload.get("items", []):
            competitors = ev.get("competitors") or []
            if len(competitors) < 2:
                continue
            home_ids = set(ev.get("homeCompetitorIds") or [])
            home = next((c["name"] for c in competitors if c.get("id") in home_ids), competitors[0]["name"])
            away = next((c["name"] for c in competitors if c.get("id") not in home_ids), competitors[1]["name"])
            event_key = make_event_key(bucket, home, away)
            markets = {m.get("marketId"): m for m in ev.get("probabilities", {}).get("markets", [])}
            start = self._parse_time(ev.get("eventDate"))
            is_live = bool(ev.get("live"))
            ev_id = ev.get("id")

            totals = self._extract_totals(markets.get(TOTAL_MARKET))
            if len(totals) >= 2:
                offers.append(
                    self._offer("totals", bucket, event_key, home, away, start, is_live, totals, ev_id)
                )
            handicaps = self._extract_handicaps(markets.get(HANDICAP_MARKET))
            if len(handicaps) >= 2:
                offers.append(
                    self._offer("handicap", bucket, event_key, home, away, start, is_live, handicaps, ev_id)
                )
        return offers

    def _offer(self, market, bucket, key, home, away, start, live, sels, ev_id) -> BookmakerOffer:
        return BookmakerOffer(
            bookmaker="Olimp",
            sport=bucket,
            market=market,
            event_key=key,
            home=home,
            away=away,
            start_time=start,
            is_live=live,
            selections=sels,
            link=f"{BASE}/live/event/{ev_id}",
        )

    @staticmethod
    def _extract_totals(market: dict | None) -> list[Selection]:
        if not market:
            return []
        sels: list[Selection] = []
        for p in market.get("probabilities", []):
            side = TOTAL_SIDES.get(p.get("outcomeTypeId"))
            odd = p.get("odd")
            line = _param_value(p)
            if side and line is not None and isinstance(odd, (int, float)) and odd > 1.0:
                sels.append(Selection(name=side, odd=float(odd), line=line))
        return sels

    @staticmethod
    def _extract_handicaps(market: dict | None) -> list[Selection]:
        if not market:
            return []
        sels: list[Selection] = []
        for p in market.get("probabilities", []):
            side = HANDICAP_SIDES.get(p.get("outcomeTypeId"))
            odd = p.get("odd")
            value = _param_value(p)
            if not side or value is None or not isinstance(odd, (int, float)) or odd <= 1.0:
                continue
            # Normalize to home perspective: away handicap h means home line -h.
            line = value if side == "H1" else -value
            sels.append(Selection(name=side, odd=float(odd), line=round(line, 2)))
        return sels

    @staticmethod
    def _parse_time(value) -> datetime | None:
        if not value:
            return None
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)
        except (ValueError, TypeError):
            return None
