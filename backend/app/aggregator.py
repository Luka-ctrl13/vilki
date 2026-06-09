"""Aggregation layer: turn raw parser offers into matches and detected surebets.

Pipeline:
    1. Run every enabled parser (in parallel, isolated from each other).
    2. Group offers by (sport, market, event_key).
    3. For each group, collect the best odd per outcome across bookmakers.
    4. Run the arbitrage engine; keep groups whose arb index < 1.
    5. Persist both the raw matches and the surebets as JSON files.
"""
from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from app.arbitrage import BestPrice, evaluate_market
from app.models import BookmakerOffer, Surebet, SurebetLeg
from app.parsers.base import BaseParser

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class Aggregator:
    """Holds the parser set and the latest computed state."""

    def __init__(self, parsers: list[BaseParser], default_stake: float = 1000.0):
        self.parsers = parsers
        self.default_stake = default_stake
        self.last_offers: list[BookmakerOffer] = []
        self.last_surebets: list[Surebet] = []
        self.last_run: datetime | None = None

    async def collect(self) -> list[BookmakerOffer]:
        """Fetch from all enabled parsers concurrently; failures yield no offers."""
        active = [p for p in self.parsers if getattr(p, "enabled", True)]
        results = await asyncio.gather(*(p.safe_fetch() for p in active))
        offers = [o for batch in results for o in batch]
        self.last_offers = offers
        return offers

    @staticmethod
    def group(offers: list[BookmakerOffer]) -> dict[tuple[str, str, str], list[BookmakerOffer]]:
        groups: dict[tuple[str, str, str], list[BookmakerOffer]] = defaultdict(list)
        for o in offers:
            groups[(o.sport, o.market, o.event_key)].append(o)
        return groups

    def find_surebets(
        self, offers: list[BookmakerOffer], total_stake: float | None = None
    ) -> list[Surebet]:
        stake = total_stake or self.default_stake
        surebets: list[Surebet] = []

        for (sport, market, event_key), group in self.group(offers).items():
            # Need at least two distinct bookmakers to have any chance of an arb.
            if len({o.bookmaker for o in group}) < 2:
                continue

            # Build outcome -> [BestPrice across all bookmakers].
            outcome_offers: dict[str, list[BestPrice]] = defaultdict(list)
            all_outcomes: set[str] = set()
            for o in group:
                for sel in o.selections:
                    outcome_offers[sel.name].append(
                        BestPrice(outcome=sel.name, bookmaker=o.bookmaker, odd=sel.odd, link=o.link)
                    )
                all_outcomes.update(s.name for s in o.selections)

            # Only evaluate markets where every outcome is priced by someone.
            if any(not outcome_offers[oc] for oc in all_outcomes) or len(all_outcomes) < 2:
                continue

            try:
                result = evaluate_market(
                    {oc: outcome_offers[oc] for oc in all_outcomes}, total_stake=stake
                )
            except ValueError:
                continue

            if not result.is_surebet:
                continue

            ref = group[0]
            legs = [
                SurebetLeg(
                    outcome=leg.outcome,
                    bookmaker=leg.bookmaker,
                    odd=leg.odd,
                    implied_prob=round(leg.implied_prob, 4),
                    stake=leg.stake,
                    stake_pct=leg.stake_pct,
                    link=leg.link,
                )
                for leg in result.legs
            ]
            surebets.append(
                Surebet(
                    sport=sport,
                    market=market,
                    event_key=event_key,
                    home=ref.home,
                    away=ref.away,
                    start_time=ref.start_time,
                    is_live=any(o.is_live for o in group),
                    legs=legs,
                    arb_index=result.arb_index,
                    profit_pct=result.profit_pct,
                    total_stake=result.total_stake,
                    bookmakers=sorted({leg.bookmaker for leg in legs}),
                )
            )

        surebets.sort(key=lambda s: s.profit_pct, reverse=True)
        return surebets

    async def run(self, total_stake: float | None = None) -> list[Surebet]:
        """Full cycle: collect, detect, persist. Returns the surebets."""
        offers = await self.collect()
        surebets = self.find_surebets(offers, total_stake=total_stake)
        self.last_surebets = surebets
        self.last_run = datetime.utcnow()
        self._persist(offers, surebets)
        return surebets

    def _persist(self, offers: list[BookmakerOffer], surebets: list[Surebet]) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        ts = (self.last_run or datetime.utcnow()).isoformat()
        (DATA_DIR / "matches.json").write_text(
            json.dumps(
                {"generated_at": ts, "offers": [o.model_dump(mode="json") for o in offers]},
                ensure_ascii=False,
                indent=2,
            )
        )
        (DATA_DIR / "surebets.json").write_text(
            json.dumps(
                {"generated_at": ts, "surebets": [s.model_dump(mode="json") for s in surebets]},
                ensure_ascii=False,
                indent=2,
            )
        )
