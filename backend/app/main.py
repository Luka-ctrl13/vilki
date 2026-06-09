"""FastAPI application: serves matches, detected surebets and on-demand stake calc.

A background task refreshes data from all parsers on an interval so the API
always returns a recent snapshot without blocking requests.
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from app.aggregator import Aggregator
from app.arbitrage import BestPrice, evaluate_market
from app.models import BookmakerOffer
from app.parsers.demo import DemoParser
from app.parsers.the_odds_api import TheOddsApiParser

REFRESH_SECONDS = int(os.getenv("REFRESH_SECONDS", "20"))
DEFAULT_STAKE = float(os.getenv("DEFAULT_STAKE", "1000"))


def build_aggregator() -> Aggregator:
    """Assemble the parser set. The real parser self-disables without an API key."""
    parsers = [TheOddsApiParser(), DemoParser(arb_ratio=0.4)]
    return Aggregator(parsers, default_stake=DEFAULT_STAKE)


aggregator = build_aggregator()


async def _refresh_loop() -> None:
    while True:
        try:
            await aggregator.run()
        except Exception:  # noqa: BLE001 - never let the loop die
            import logging

            logging.getLogger("refresh").exception("refresh cycle failed")
        await asyncio.sleep(REFRESH_SECONDS)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await aggregator.run()  # warm the first snapshot before serving
    task = asyncio.create_task(_refresh_loop())
    yield
    task.cancel()


app = FastAPI(title="Vilki — Arbitrage Finder", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "last_run": aggregator.last_run.isoformat() if aggregator.last_run else None,
        "offers": len(aggregator.last_offers),
        "surebets": len(aggregator.last_surebets),
        "parsers": [
            {"name": p.name, "enabled": getattr(p, "enabled", True)} for p in aggregator.parsers
        ],
    }


@app.get("/api/surebets")
async def surebets(
    sport: str | None = Query(None, description="Filter by sport bucket"),
    min_profit: float = Query(0.0, description="Minimum profit percent"),
    live_only: bool = Query(False),
    stake: float | None = Query(None, description="Recompute stakes for this bankroll"),
):
    """Detected surebets. If `stake` is given, stakes are recomputed for it."""
    if stake:
        items = aggregator.find_surebets(aggregator.last_offers, total_stake=stake)
    else:
        items = aggregator.last_surebets

    def keep(s):
        if sport and s.sport != sport:
            return False
        if s.profit_pct < min_profit:
            return False
        if live_only and not s.is_live:
            return False
        return True

    result = [s for s in items if keep(s)]
    return {
        "count": len(result),
        "last_run": aggregator.last_run.isoformat() if aggregator.last_run else None,
        "surebets": [s.model_dump(mode="json") for s in result],
    }


@app.get("/api/matches")
async def matches(sport: str | None = Query(None)):
    """All current bookmaker offers (the raw parsed odds)."""
    offers = aggregator.last_offers
    if sport:
        offers = [o for o in offers if o.sport == sport]
    return {
        "count": len(offers),
        "offers": [o.model_dump(mode="json") for o in offers],
    }


@app.post("/api/calc")
async def calc(payload: dict):
    """Calculate arbitrage for a manually supplied market.

    Body: {"outcomes": {"1": [{"bookmaker":"A","odd":2.1}, ...], ...}, "stake": 1000}
    Lets a user check any odds by hand without going through a parser.
    """
    outcomes_in = payload.get("outcomes", {})
    stake = float(payload.get("stake", DEFAULT_STAKE))
    outcome_odds: dict[str, list[BestPrice]] = {}
    for name, offers in outcomes_in.items():
        outcome_odds[name] = [
            BestPrice(outcome=name, bookmaker=o.get("bookmaker", "?"), odd=float(o["odd"]))
            for o in offers
        ]
    result = evaluate_market(outcome_odds, total_stake=stake)
    return {
        "arb_index": result.arb_index,
        "profit_pct": result.profit_pct,
        "is_surebet": result.is_surebet,
        "total_stake": result.total_stake,
        "legs": [leg.__dict__ for leg in result.legs],
    }
