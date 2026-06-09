"""Real-data parser using The Odds API (https://the-odds-api.com).

The Odds API aggregates live and pre-match odds from many real bookmakers
(Pinnacle, William Hill, Betfair, etc.) and returns clean JSON — which is
exactly what an arbitrage finder needs, since arbitrage requires several
bookmakers pricing the same event.

Activation: set the THE_ODDS_API_KEY environment variable to a free key from
https://the-odds-api.com. Without a key the parser disables itself and the
aggregator silently skips it, so the app still runs on the demo parser.

Free tier is rate-limited, so this parser fetches a small set of sports and
the h2h (money line) market by default — the cleanest market for arbitrage.
"""
from __future__ import annotations

import os
from datetime import datetime

import httpx

from app.models import BookmakerOffer, Selection
from app.parsers.base import BaseParser, make_event_key

API_BASE = "https://api.the-odds-api.com/v4"

# A small default basket of sports. Override via THE_ODDS_API_SPORTS (comma-separated).
DEFAULT_SPORTS = [
    "soccer_epl",
    "soccer_uefa_champs_league",
    "tennis_atp",
    "basketball_nba",
]

# Map The Odds API sport keys onto our coarse sport buckets / market labels.
_SPORT_BUCKET = {
    "soccer": "soccer",
    "tennis": "tennis",
    "basketball": "basketball",
    "icehockey": "hockey",
    "baseball": "baseball",
    "americanfootball": "am_football",
}


def _bucket(sport_key: str) -> str:
    head = sport_key.split("_", 1)[0]
    return _SPORT_BUCKET.get(head, head)


class TheOddsApiParser(BaseParser):
    name = "the_odds_api"

    def __init__(self, api_key: str | None = None, regions: str = "eu", timeout: float = 15.0):
        self.api_key = api_key or os.getenv("THE_ODDS_API_KEY", "").strip()
        self.regions = os.getenv("THE_ODDS_API_REGIONS", regions)
        self.timeout = timeout
        sports_env = os.getenv("THE_ODDS_API_SPORTS", "").strip()
        self.sports = [s.strip() for s in sports_env.split(",") if s.strip()] or DEFAULT_SPORTS
        # Disable when no key so the aggregator skips us cleanly.
        self.enabled = bool(self.api_key)

    async def fetch(self) -> list[BookmakerOffer]:
        if not self.enabled:
            return []

        offers: list[BookmakerOffer] = []
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            for sport_key in self.sports:
                params = {
                    "apiKey": self.api_key,
                    "regions": self.regions,
                    "markets": "h2h",
                    "oddsFormat": "decimal",
                }
                url = f"{API_BASE}/sports/{sport_key}/odds"
                resp = await client.get(url, params=params)
                if resp.status_code != 200:
                    # 401/404/429 etc. — skip this sport, keep the rest working.
                    import logging

                    logging.getLogger("parsers").warning(
                        "the_odds_api %s -> HTTP %s", sport_key, resp.status_code
                    )
                    continue
                offers.extend(self._parse_sport(sport_key, resp.json()))
        return offers

    def _parse_sport(self, sport_key: str, events: list[dict]) -> list[BookmakerOffer]:
        bucket = _bucket(sport_key)
        out: list[BookmakerOffer] = []
        for ev in events:
            home = ev.get("home_team") or ""
            away = ev.get("away_team") or ""
            if not home or not away:
                continue
            start = self._parse_time(ev.get("commence_time"))
            is_live = start is not None and start <= datetime.utcnow()
            event_key = make_event_key(bucket, home, away)

            for bm in ev.get("bookmakers", []):
                book = bm.get("title") or bm.get("key") or "unknown"
                for market in bm.get("markets", []):
                    if market.get("key") != "h2h":
                        continue
                    sels = self._parse_h2h(market.get("outcomes", []), home, away)
                    if len(sels) < 2:
                        continue
                    out.append(
                        BookmakerOffer(
                            bookmaker=book,
                            sport=bucket,
                            market="h2h",
                            event_key=event_key,
                            home=home,
                            away=away,
                            start_time=start,
                            is_live=is_live,
                            selections=sels,
                        )
                    )
        return out

    @staticmethod
    def _parse_h2h(outcomes: list[dict], home: str, away: str) -> list[Selection]:
        """Normalize h2h outcomes to labels 1/X/2 by team name and 'Draw'."""
        sels: list[Selection] = []
        for o in outcomes:
            name = o.get("name", "")
            price = o.get("price")
            if not isinstance(price, (int, float)) or price <= 1.0:
                continue
            if name == home:
                label = "1"
            elif name == away:
                label = "2"
            elif name.lower() in {"draw", "tie"}:
                label = "X"
            else:
                label = name
            sels.append(Selection(name=label, odd=float(price)))
        return sels

    @staticmethod
    def _parse_time(value) -> datetime | None:
        if not value:
            return None
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)
        except (ValueError, TypeError):
            return None
