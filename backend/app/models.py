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

    For totals/handicaps the `name` is the side ("Over"/"Under" for totals,
    "H1"/"H2" for handicaps) and `line` is the threshold. The line is always
    expressed from the home team's perspective for handicaps, so the same
    real-world line lines up across bookmakers (Over 2.5 vs Over 2.5; Home -1.5
    vs Away +1.5 both map to home line -1.5).
    """

    name: str
    odd: float = Field(gt=1.0, description="Decimal odd, must be > 1.0")
    line: Optional[float] = Field(default=None, description="Total/handicap line, home-perspective")


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
    line: Optional[float] = None
    implied_prob: float
    stake: float
    stake_pct: float
    link: Optional[str] = None


class Surebet(BaseModel):
    """A detected arbitrage opportunity across bookmakers for one market of one event."""

    id: str = Field(description="Stable id: event_key|market|line — used to reference a bet")
    sport: str
    market: str
    line: Optional[float] = Field(default=None, description="Total/handicap line of this surebet")
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
