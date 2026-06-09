"""1xbet live-odds parser via the public LiveFeed JSON API.

1xbet's front-end feeds the live page from:

    GET {BASE}/LiveFeed/Get1x2_VZip
        ?sports=<sportId>&count=N&lng=ru&mode=4&country=1&partner=51
        &top=false&virtualSports=true&noFilterBlockEvent=true

Response shape (trimmed):
    { "Success": true,
      "Value": [
        { "I": 123456789,            # game id
          "O1": "Home Team", "O2": "Away Team",
          "S": 1733770000,            # start unix ts
          "E": [                      # main 1x2 market
            {"T": 1, "C": 2.10},      # T=1 -> W1 (home)
            {"T": 2, "C": 3.40},      # T=2 -> X  (draw)
            {"T": 3, "C": 3.10}       # T=3 -> W2 (away)
          ] }, ...
      ] }

Note on availability: 1xbet geo-blocks data-center IP ranges (requests get
redirected to /en/block), so this parser will return nothing from a blocked
host. Run it from an allowed region/residential IP, or point BASE at a working
mirror via the ONEXBET_BASE_URL env var. The parser fails safe (returns []).
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime

import httpx

from app.models import BookmakerOffer, Selection
from app.parsers.base import BaseParser, make_event_key

BASE = os.getenv("ONEXBET_BASE_URL", "https://1xbet.com")

# 1xbet sportId -> our coarse sport bucket.
SPORT_BUCKETS = {
    1: "soccer",
    2: "hockey",
    3: "basketball",
    4: "tennis",
    10: "table_tennis",
    3000: "volleyball",  # volleyball id varies by mirror; harmless if absent
}

# Main 1x2 market: event type T -> our label.
OUTCOME_LABELS = {1: "1", 2: "X", 3: "2"}


class OneXBetParser(BaseParser):
    name = "onexbet"

    def __init__(self, count: int = 40, timeout: float = 15.0, concurrency: int = 3, lng: str = "ru"):
        self.count = count
        self.timeout = timeout
        self.lng = lng
        self._sem = asyncio.Semaphore(concurrency)
        self.enabled = os.getenv("ONEXBET_ENABLED", "1") != "0"

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "Accept": "application/json",
            "Referer": f"{BASE}/en/live",
        }

    async def fetch(self) -> list[BookmakerOffer]:
        if not self.enabled:
            return []
        # follow_redirects=False so a geo-block 302 yields nothing instead of HTML.
        async with httpx.AsyncClient(
            timeout=self.timeout, headers=self._headers, follow_redirects=False
        ) as client:
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
        params = {
            "sports": sport_id,
            "count": self.count,
            "lng": self.lng,
            "mode": 4,
            "country": 1,
            "partner": 51,
            "top": "false",
            "virtualSports": "true",
            "noFilterBlockEvent": "true",
        }
        async with self._sem:
            resp = await client.get(f"{BASE}/LiveFeed/Get1x2_VZip", params=params)
        if resp.status_code != 200:
            import logging

            logging.getLogger("parsers").warning(
                "onexbet sport %s -> HTTP %s (geo-block?)", sport_id, resp.status_code
            )
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        return self._parse(data, bucket)

    def _parse(self, data: dict, bucket: str) -> list[BookmakerOffer]:
        offers: list[BookmakerOffer] = []
        for game in data.get("Value", []) or []:
            home = game.get("O1") or ""
            away = game.get("O2") or ""
            if not home or not away:
                continue
            sels = self._extract_1x2(game.get("E", []))
            if len(sels) < 2:
                continue
            offers.append(
                BookmakerOffer(
                    bookmaker="1xbet",
                    sport=bucket,
                    market="1x2",
                    event_key=make_event_key(bucket, home, away),
                    home=home,
                    away=away,
                    start_time=self._parse_time(game.get("S")),
                    is_live=True,  # Get1x2_VZip is the live feed
                    selections=sels,
                    link=f"{BASE}/en/live/{game.get('I')}",
                )
            )
        return offers

    @staticmethod
    def _extract_1x2(events: list[dict]) -> list[Selection]:
        sels: list[Selection] = []
        for e in events or []:
            label = OUTCOME_LABELS.get(e.get("T"))
            coef = e.get("C")
            if label and isinstance(coef, (int, float)) and coef > 1.0:
                sels.append(Selection(name=label, odd=float(coef)))
        return sels

    @staticmethod
    def _parse_time(ts) -> datetime | None:
        if not ts:
            return None
        try:
            return datetime.utcfromtimestamp(int(ts))
        except (ValueError, TypeError, OSError):
            return None
