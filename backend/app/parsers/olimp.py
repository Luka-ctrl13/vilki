"""Olimp (olimpbet.kz) live-odds parser.

Reverse-engineered from the site's own public JSON API (no auth needed for the
betting line, only a platform header):

    GET https://olimpbet.kz/api/v2/events
        ?locale=ru&sport-ids=100&live=true&page-size=N&statuses=OPEN&statuses=TRADING
    headers: x-platform: web-desktop

Response shape (trimmed):
    items: [
      {
        competitors: [{id, name, ...}, ...],
        homeCompetitorIds: [id],
        live: bool, eventDate: ISO,
        tournament: {sportId, ...},
        probabilities: {
          markets: [
            { marketId: 1000,                 # MATCH_WINNER_X3 == 1X2
              probabilities: [
                {outcomeTypeId: 1000, odd: 12.5},   # 1000 = П1 (home)
                {outcomeTypeId: 1001, odd: 3.75},   # 1001 = Х  (draw)
                {outcomeTypeId: 1002, odd: 1.36},   # 1002 = П2 (away)
              ]
            }, ...
          ]
        }
      }, ...
    ]

We read market 1000 (and 1001/MATCH_WINNER_X2 is ignored) and emit a 1x2 /
h2h offer per event. Two-competitor sports (tennis, table tennis, …) only
carry П1/П2, which the engine handles as a 2-way market.
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime

import httpx

from app.models import BookmakerOffer, Selection
from app.parsers.base import BaseParser, make_event_key

BASE = os.getenv("OLIMP_BASE_URL", "https://olimpbet.kz")

# Olimp sportId -> our coarse sport bucket. Only sports we actually use for arbs.
SPORT_BUCKETS = {
    100: "soccer",
    101: "tennis",
    102: "basketball",
    103: "hockey",
    104: "volleyball",
    110: "table_tennis",
}

# Market 1000 = MATCH_WINNER_X3 (1X2). outcomeTypeId -> our label.
MARKET_1X2 = 1000
OUTCOME_LABELS = {1000: "1", 1001: "X", 1002: "2"}


class OlimpParser(BaseParser):
    name = "olimp"

    def __init__(self, page_size: int = 40, timeout: float = 15.0, concurrency: int = 3):
        self.page_size = page_size
        self.timeout = timeout
        # Polite concurrency cap so we never hammer the bookmaker.
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
            tasks = [self._fetch_sport(client, sid, bucket) for sid, bucket in SPORT_BUCKETS.items()]
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

            sels = self._extract_1x2(ev.get("probabilities") or {})
            if len(sels) < 2:
                continue

            offers.append(
                BookmakerOffer(
                    bookmaker="Olimp",
                    sport=bucket,
                    market="1x2",
                    event_key=make_event_key(bucket, home, away),
                    home=home,
                    away=away,
                    start_time=self._parse_time(ev.get("eventDate")),
                    is_live=bool(ev.get("live")),
                    selections=sels,
                    link=f"{BASE}/live/event/{ev.get('id')}",
                )
            )
        return offers

    @staticmethod
    def _extract_1x2(probabilities: dict) -> list[Selection]:
        sels: list[Selection] = []
        for market in probabilities.get("markets", []):
            if market.get("marketId") != MARKET_1X2:
                continue
            for p in market.get("probabilities", []):
                label = OUTCOME_LABELS.get(p.get("outcomeTypeId"))
                odd = p.get("odd")
                if label and isinstance(odd, (int, float)) and odd > 1.0:
                    sels.append(Selection(name=label, odd=float(odd)))
            break
        return sels

    @staticmethod
    def _parse_time(value) -> datetime | None:
        if not value:
            return None
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)
        except (ValueError, TypeError):
            return None
