"""Demo parser: generates realistic live totals & handicaps from several books.

It exists so the whole pipeline — fetch -> aggregate -> detect -> API -> UI —
works end-to-end without any external dependency, and so DEMO_FALLBACK can
demonstrate surebets when the real bookmakers are blocked. A configurable share
of (event, line) markets is seeded with a genuine arbitrage.
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta

from app.models import BookmakerOffer, Selection
from app.parsers.base import BaseParser, make_event_key

BOOKMAKERS = ["BetAlpha", "OddsKing", "ProBet", "LiveLine"]

# (sport, home, away, total_line, handicap_line)
_FIXTURES = [
    ("soccer", "Manchester City", "Liverpool", 2.5, -1.0),
    ("soccer", "Real Madrid", "Barcelona", 3.5, 0.0),
    ("tennis", "Djokovic", "Alcaraz", 22.5, -3.5),
    ("basketball", "Lakers", "Celtics", 210.5, -4.5),
    ("table_tennis", "Wang Chuqin", "Ma Long", 18.5, -1.5),
]


def _odds(rng: random.Random, fair_p: float, boost_a: bool, boost_b: bool) -> tuple[float, float]:
    """Return (odd_side_a, odd_side_b). A boosted side is priced above fair.

    A surebet appears when side A is boosted at one book and side B at another,
    so the best price of each side combines to an implied total below 1.
    """
    ma = -0.03 if boost_a else rng.uniform(0.04, 0.08)
    mb = -0.03 if boost_b else rng.uniform(0.04, 0.08)
    return round(1 / (fair_p * (1 + ma)), 2), round(1 / ((1 - fair_p) * (1 + mb)), 2)


class DemoParser(BaseParser):
    name = "demo"

    def __init__(self, arb_ratio: float = 0.4, seed: int | None = None):
        self.arb_ratio = arb_ratio
        self._rng = random.Random(seed)

    async def fetch(self) -> list[BookmakerOffer]:
        offers: list[BookmakerOffer] = []
        now = datetime.utcnow()

        for sport, home, away, total_line, hcap_line in _FIXTURES:
            event_key = make_event_key(sport, home, away)
            start = now + timedelta(minutes=self._rng.randint(-30, 90))
            is_live = start <= now

            for market, line, sides, fair in (
                ("totals", total_line, ("Over", "Under"), self._rng.uniform(0.45, 0.55)),
                ("handicap", hcap_line, ("H1", "H2"), self._rng.uniform(0.45, 0.55)),
            ):
                # For an arb, boost side A at one book and side B at another
                # (distinct) book, so the best price of each side comes from a
                # different bookmaker.
                if self._rng.random() < self.arb_ratio:
                    book_a, book_b = self._rng.sample(BOOKMAKERS, 2)
                else:
                    book_a = book_b = None

                for book in BOOKMAKERS:
                    oa, ob = _odds(self._rng, fair, boost_a=book == book_a, boost_b=book == book_b)
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
                            selections=[
                                Selection(name=sides[0], odd=oa, line=line),
                                Selection(name=sides[1], odd=ob, line=line),
                            ],
                            link=f"https://example-bookmaker.test/{book.lower()}/{event_key}",
                        )
                    )
        return offers
