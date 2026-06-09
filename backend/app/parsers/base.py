"""Parser plugin interface.

Every data source — a real bookmaker scraper, an odds API, or a demo
generator — implements `BaseParser`. The aggregator only knows this
interface, so new bookmakers plug in without touching the engine or API.

A parser's one job: produce a flat list of `BookmakerOffer`. Normalization
of outcome labels and event keys is the parser's responsibility, so that the
same real-world event lines up across different sources (see `make_event_key`).
"""
from __future__ import annotations

import re
import unicodedata
from abc import ABC, abstractmethod

from app.models import BookmakerOffer


def _slug(text: str) -> str:
    """Normalize a team/player name into a comparable slug.

    Lowercases, strips accents and punctuation, collapses whitespace. This is
    what lets "Man. City" and "Manchester City" *not* accidentally differ on
    punctuation while still being matched by the aggregator's alias logic.
    """
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower()
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def make_event_key(sport: str, home: str, away: str) -> str:
    """Build a stable, source-independent key for an event.

    Teams are sorted so that home/away ordering differences between
    bookmakers don't split one event into two.
    """
    a, b = sorted([_slug(home), _slug(away)])
    return f"{_slug(sport)}::{a}::vs::{b}"


class BaseParser(ABC):
    """Abstract data source. Subclasses implement async `fetch`."""

    #: Human-readable source name, also used as a config key.
    name: str = "base"

    #: If False the aggregator skips this parser (e.g. real parser with no API key).
    enabled: bool = True

    @abstractmethod
    async def fetch(self) -> list[BookmakerOffer]:
        """Return current offers from this source. Must not raise on empty data."""
        raise NotImplementedError

    async def safe_fetch(self) -> list[BookmakerOffer]:
        """Fetch wrapper that never raises — a broken parser can't take the site down."""
        try:
            return await self.fetch()
        except Exception as exc:  # noqa: BLE001 - isolation is the whole point
            import logging

            logging.getLogger("parsers").warning("parser %s failed: %s", self.name, exc)
            return []
