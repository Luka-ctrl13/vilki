"""Tests for the bet automation: risk gates, paper fills, partial-fill safety."""
import asyncio

from app.betting import (
    BetCoordinator,
    BetStatus,
    LegResult,
    PaperExecutor,
    RiskConfig,
)
from app.models import Surebet, SurebetLeg


def _surebet(profit=2.0, stake=1000.0, books=("Olimp", "1xbet")) -> Surebet:
    return Surebet(
        id="evt|totals|2.5",
        sport="soccer",
        market="totals",
        line=2.5,
        event_key="evt",
        home="A",
        away="B",
        legs=[
            SurebetLeg(outcome="Over", bookmaker=books[0], odd=2.1, line=2.5,
                       implied_prob=0.476, stake=stake / 2, stake_pct=50.0),
            SurebetLeg(outcome="Under", bookmaker=books[1], odd=2.1, line=2.5,
                       implied_prob=0.476, stake=stake / 2, stake_pct=50.0),
        ],
        arb_index=0.95,
        profit_pct=profit,
        total_stake=stake,
        bookmakers=list(books),
    )


def _paper_coord(**risk) -> BetCoordinator:
    cfg = RiskConfig(enabled=True, mode="paper", **risk)
    execs = {"Olimp": PaperExecutor("Olimp"), "1xbet": PaperExecutor("1xbet")}
    return BetCoordinator(execs, cfg)


def test_kill_switch_blocks_placement():
    coord = _paper_coord()
    coord.risk.enabled = False
    bet = asyncio.run(coord.place_surebet(_surebet()))
    assert bet.status == BetStatus.REJECTED
    assert "kill-switch" in bet.note


def test_paper_placement_simulated():
    coord = _paper_coord()
    bet = asyncio.run(coord.place_surebet(_surebet()))
    assert bet.status == BetStatus.SIMULATED
    assert len(bet.legs) == 2 and all(l.ok for l in bet.legs)


def test_min_profit_gate():
    coord = _paper_coord(min_profit_pct=3.0)
    bet = asyncio.run(coord.place_surebet(_surebet(profit=1.0)))
    assert bet.status == BetStatus.REJECTED
    assert "below min" in bet.note


def test_max_stake_gate():
    coord = _paper_coord(max_stake_per_bet=500)
    bet = asyncio.run(coord.place_surebet(_surebet(stake=1000)))
    assert bet.status == BetStatus.REJECTED


def test_dedup_blocks_second_placement():
    coord = _paper_coord()
    sb = _surebet()
    first = asyncio.run(coord.place_surebet(sb))
    second = asyncio.run(coord.place_surebet(sb))
    assert first.status == BetStatus.SIMULATED
    assert second.status == BetStatus.REJECTED
    assert "already placed" in second.note


def test_missing_executor_rejected():
    coord = _paper_coord()
    bet = asyncio.run(coord.place_surebet(_surebet(books=("Olimp", "UnknownBook"))))
    assert bet.status == BetStatus.REJECTED
    assert "no executor" in bet.note


def test_partial_fill_flagged_unhedged():
    # One leg's executor always fails -> the bet must be marked PARTIAL, not OK.
    class Failing(PaperExecutor):
        async def place(self, leg):
            return LegResult(self.bookmaker, leg.outcome, leg.line, leg.stake,
                             leg.odd, None, ok=False, message="rejected")

    cfg = RiskConfig(enabled=True, mode="paper")
    coord = BetCoordinator({"Olimp": PaperExecutor("Olimp"), "1xbet": Failing("1xbet")}, cfg)
    bet = asyncio.run(coord.place_surebet(_surebet()))
    assert bet.status == BetStatus.PARTIAL
    assert "UNHEDGED" in bet.note


def test_stake_override_rescales_legs():
    coord = _paper_coord()
    bet = asyncio.run(coord.place_surebet(_surebet(stake=1000), stake=2000))
    assert abs(bet.total_stake - 2000) < 1.0
