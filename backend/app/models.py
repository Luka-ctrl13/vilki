"""Data models for matches, odds and detected arbitrage opportunities (surebets).

The whole pipeline speaks these models:
    parser  ->  list[BookmakerOffer]  ->  aggregator groups into Event  ->  engine -> Surebet
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class Selection(BaseModel):
    """A single possible outcome of a market with the odd a bookmaker gives it.

    `name` is the normalized outcome label, e.g. "1" / "X" / "2" for football
    1X2, or the player/team name for a two-way money line.
    """

    name: str
    odd: float = Field(gt=1.0, description="Decimal odd, must be > 1.0")


class BookmakerOffer(BaseModel):
    """One bookmaker's pricing of one market of one event.

    Parsers emit a flat list of these. The aggregator groups them by
    (sport, market, event_key).
    """

    bookmaker: str
    sport: str
    market: str = Field(description="Market key, e.g. 'h2h', '1x2', 'totals'")
    event_key: str = Field(description="Stable id matching the same event across bookmakers")
    home: str
    away: str
    start_time: Optional[datetime] = None
    is_live: bool = False
    selections: list[Selection]
    link: Optional[str] = None
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class SurebetLeg(BaseModel):
    """One bet of a surebet: which bookmaker, which outcome, at which odd, how much to stake."""

    outcome: str
    bookmaker: str
    odd: float
    implied_prob: float
    stake: float
    stake_pct: float
    link: Optional[str] = None


class Surebet(BaseModel):
    """A detected arbitrage opportunity across bookmakers for one market of one event."""

    sport: str
    market: str
    event_key: str
    home: str
    away: str
    start_time: Optional[datetime] = None
    is_live: bool = False
    legs: list[SurebetLeg]
    arb_index: float = Field(description="Sum of best implied probabilities; < 1 means a surebet")
    profit_pct: float = Field(description="Guaranteed return on total stake, in percent")
    total_stake: float
    bookmakers: list[str]
    detected_at: datetime = Field(default_factory=datetime.utcnow)
