"""Demo parser: generates realistic live odds from several fake bookmakers.

It exists so the whole pipeline — fetch -> aggregate -> detect -> API -> UI —
works end-to-end without any external dependency or API key. A configurable
share of events is seeded with a genuine arbitrage so the UI always has
something to show.

Each call to `fetch` jitters the odds slightly to imitate a live feed.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta

from app.models import BookmakerOffer, Selection
from app.parsers.base import BaseParser, make_event_key

BOOKMAKERS = ["BetAlpha", "OddsKing", "ProBet", "LiveLine"]

# (sport, market, outcome labels, home, away)
_FIXTURES = [
    ("soccer", "1x2", ["1", "X", "2"], "Manchester City", "Liverpool"),
    ("soccer", "1x2", ["1", "X", "2"], "Real Madrid", "Barcelona"),
    ("soccer", "1x2", ["1", "X", "2"], "Bayern", "Dortmund"),
    ("tennis", "h2h", ["1", "2"], "Djokovic", "Alcaraz"),
    ("tennis", "h2h", ["1", "2"], "Sabalenka", "Swiatek"),
    ("basketball", "h2h", ["1", "2"], "Lakers", "Celtics"),
    ("table_tennis", "h2h", ["1", "2"], "Wang Chuqin", "Ma Long"),
]


def _fair_probs(n: int, seed: int) -> list[float]:
    """Random fair probabilities for n outcomes, summing to 1."""
    rng = random.Random(seed)
    weights = [rng.uniform(0.5, 2.0) for _ in range(n)]
    total = sum(weights)
    return [w / total for w in weights]


class DemoParser(BaseParser):
    name = "demo"

    def __init__(self, arb_ratio: float = 0.4, seed: int | None = None):
        # arb_ratio: share of events that should contain a real surebet.
        self.arb_ratio = arb_ratio
        self._rng = random.Random(seed)

    async def fetch(self) -> list[BookmakerOffer]:
        offers: list[BookmakerOffer] = []
        now = datetime.utcnow()

        for idx, (sport, market, outcomes, home, away) in enumerate(_FIXTURES):
            fair = _fair_probs(len(outcomes), seed=idx)
            event_key = make_event_key(sport, home, away)
            start = now + timedelta(minutes=self._rng.randint(-30, 90))
            is_live = start <= now
            force_arb = self._rng.random() < self.arb_ratio

            # For a forced arb, give each outcome its best price at a *different*
            # bookmaker, with a combined margin below zero.
            arb_books = self._rng.sample(BOOKMAKERS, k=len(outcomes)) if force_arb else None

            for b_i, book in enumerate(BOOKMAKERS):
                sels: list[Selection] = []
                for o_i, outcome in enumerate(outcomes):
                    p = fair[o_i]
                    if force_arb and arb_books[o_i] == book:
                        # Slightly *over* fair odds at one book -> creates the arb.
                        margin = -0.025
                    else:
                        # Normal bookmaker overround spread across outcomes.
                        margin = self._rng.uniform(0.04, 0.08)
                    jitter = self._rng.uniform(-0.01, 0.01)
                    odd = round(1.0 / (p * (1 + margin) + jitter), 2)
                    odd = max(odd, 1.01)
                    sels.append(Selection(name=outcome, odd=odd))

                offers.append(
                    BookmakerOffer(
                        bookmaker=book,
                        sport=sport,
                        market=market,
                        event_key=event_key,
                        home=home,
                        away=away,
                        start_time=start,
                        is_live=is_live,
                        selections=sels,
                        link=f"https://example-bookmaker.test/{book.lower()}/{event_key}",
                    )
                )
        return offers
