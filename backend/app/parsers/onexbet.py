"""1xbet live-odds parser — totals and handicaps via the LiveFeed JSON API.

Two-step, like the site itself:
  1. GET {BASE}/LiveFeed/Get1x2_VZip?sports=<id>&... -> live game list (ids/names)
  2. GET {BASE}/LiveFeed/GetGameZip?id=<gameId>&... -> full market tree for a game

Full-markets event codes (field `T`) in the GetGameZip tree, with the line in
field `P`:
    7  -> Handicap 1 (home),   8  -> Handicap 2 (away)
    9  -> Total Over,          10 -> Total Under
These codes are the widely-used 1xbet values; because 1xbet geo-blocks
data-center IPs we cannot verify them from here, so they live in one dict
(EVENT_CODES) that is trivial to correct against a live feed if a mirror shows
different numbering. The parser fails safe (returns []) on block/parse errors.
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime

import httpx

from app.models import BookmakerOffer, Selection
from app.parsers.base import BaseParser, make_event_key

BASE = os.getenv("ONEXBET_BASE_URL", "https://1xbet.com")

SPORT_BUCKETS = {
    1: "soccer",
    2: "hockey",
    3: "basketball",
    4: "tennis",
    10: "table_tennis",
}

# event-type code -> (market, side). Line comes from the event's `P` field.
EVENT_CODES = {
    9: ("totals", "Over"),
    10: ("totals", "Under"),
    7: ("handicap", "H1"),
    8: ("handicap", "H2"),
}

_PARTNER = os.getenv("ONEXBET_PARTNER", "51")


class OneXBetParser(BaseParser):
    name = "onexbet"

    def __init__(
        self,
        count: int = 20,
        max_games_per_sport: int = 15,
        timeout: float = 15.0,
        concurrency: int = 4,
        lng: str = "ru",
    ):
        self.count = count
        self.max_games = max_games_per_sport
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
        async with httpx.AsyncClient(
            timeout=self.timeout, headers=self._headers, follow_redirects=False
        ) as client:
            sport_tasks = [self._live_games(client, sid, b) for sid, b in SPORT_BUCKETS.items()]
            game_lists = await asyncio.gather(*sport_tasks, return_exceptions=True)

            game_tasks = []
            for gl in game_lists:
                if isinstance(gl, list):
                    for (gid, home, away, bucket) in gl[: self.max_games]:
                        game_tasks.append(self._game_markets(client, gid, home, away, bucket))
            results = await asyncio.gather(*game_tasks, return_exceptions=True)

        offers: list[BookmakerOffer] = []
        for r in results:
            if isinstance(r, list):
                offers.extend(r)
        return offers

    async def _live_games(self, client, sport_id, bucket) -> list[tuple]:
        params = {
            "sports": sport_id, "count": self.count, "lng": self.lng, "mode": 4,
            "country": 1, "partner": _PARTNER, "top": "false",
            "virtualSports": "true", "noFilterBlockEvent": "true",
        }
        async with self._sem:
            resp = await client.get(f"{BASE}/LiveFeed/Get1x2_VZip", params=params)
        if resp.status_code != 200:
            import logging
            logging.getLogger("parsers").warning(
                "onexbet list sport %s -> HTTP %s (geo-block?)", sport_id, resp.status_code
            )
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        games = []
        for g in data.get("Value", []) or []:
            gid, home, away = g.get("I"), g.get("O1"), g.get("O2")
            if gid and home and away:
                games.append((gid, home, away, bucket))
        return games

    async def _game_markets(self, client, gid, home, away, bucket) -> list[BookmakerOffer]:
        params = {
            "id": gid, "lng": self.lng, "country": 1, "partner": _PARTNER,
            "grMode": 4, "isSubGames": "true", "GroupEvents": "true",
            "countevents": 250, "marketType": 1,
        }
        async with self._sem:
            resp = await client.get(f"{BASE}/LiveFeed/GetGameZip", params=params)
        if resp.status_code != 200:
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        return self._parse_game(data.get("Value", {}), home, away, bucket)

    def _parse_game(self, value: dict, home, away, bucket) -> list[BookmakerOffer]:
        events = _collect_events(value)
        start = self._parse_time(value.get("S"))
        gid = value.get("I")
        event_key = make_event_key(bucket, home, away)

        per_market: dict[str, list[Selection]] = {"totals": [], "handicap": []}
        for e in events:
            mapping = EVENT_CODES.get(e.get("T"))
            coef, param = e.get("C"), e.get("P")
            if not mapping or not isinstance(coef, (int, float)) or coef <= 1.0 or param is None:
                continue
            market, side = mapping
            try:
                line = float(param)
            except (TypeError, ValueError):
                continue
            if market == "handicap" and side == "H2":
                line = -line  # normalize to home perspective
            per_market[market].append(Selection(name=side, odd=float(coef), line=round(line, 2)))

        offers: list[BookmakerOffer] = []
        for market, sels in per_market.items():
            if len(sels) >= 2:
                offers.append(
                    BookmakerOffer(
                        bookmaker="1xbet",
                        sport=bucket,
                        market=market,
                        event_key=event_key,
                        home=home,
                        away=away,
                        start_time=start,
                        is_live=True,
                        selections=sels,
                        link=f"{BASE}/en/live/{gid}",
                    )
                )
        return offers

    @staticmethod
    def _parse_time(ts) -> datetime | None:
        if not ts:
            return None
        try:
            return datetime.utcfromtimestamp(int(ts))
        except (ValueError, TypeError, OSError):
            return None


def _collect_events(node, out: list | None = None) -> list[dict]:
    """Recursively gather all event dicts (carrying a `T` type) from the game tree.

    GetGameZip nests events under GE -> E (lists of lists), so we walk the whole
    structure and pick out any dict that looks like a betting event.
    """
    if out is None:
        out = []
    if isinstance(node, dict):
        if "T" in node and ("C" in node or "P" in node):
            out.append(node)
        for v in node.values():
            _collect_events(v, out)
    elif isinstance(node, list):
        for v in node:
            _collect_events(v, out)
    return out
