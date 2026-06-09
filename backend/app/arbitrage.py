"""Core arbitrage (surebet) calculation engine.

This is the heart of the project and is intentionally free of any I/O,
networking or framework code so it can be unit-tested in isolation.

Theory
------
For a market with N mutually exclusive and collectively exhaustive outcomes,
a bookmaker's decimal odd `o` for an outcome implies a probability `1/o`.
A single bookmaker always prices the market with an overround:
    sum(1/o_i) > 1   (the bookmaker's margin / vig)

A surebet (arbitrage) exists when, by taking the *best* odd available for
each outcome across several bookmakers, the combined implied probability
drops below 1:
    arb_index = sum_i ( 1 / best_odd_i ) < 1

The guaranteed profit on the total stake is then:
    profit_pct = (1 / arb_index - 1) * 100

To lock that profit in regardless of the result, stakes are split so every
outcome returns the same amount:
    stake_i = total_stake * (1 / best_odd_i) / arb_index
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class BestPrice:
    """Best available odd for one outcome and where to get it."""

    outcome: str
    bookmaker: str
    odd: float
    line: float | None = None
    link: str | None = None


@dataclass
class StakeLeg:
    """How to bet one outcome of a surebet."""

    outcome: str
    bookmaker: str
    odd: float
    implied_prob: float
    stake: float
    stake_pct: float
    profit_if_wins: float
    line: float | None = None
    link: str | None = None


@dataclass
class ArbResult:
    """Result of evaluating one market. `is_surebet` is the headline answer."""

    arb_index: float
    profit_pct: float
    is_surebet: bool
    legs: list[StakeLeg]
    total_stake: float


def implied_probability(odd: float) -> float:
    """Probability implied by a decimal odd. Raises on non-positive odds."""
    if odd <= 1.0:
        raise ValueError(f"Decimal odd must be > 1.0, got {odd!r}")
    return 1.0 / odd


def best_prices(outcome_odds: dict[str, list[BestPrice]]) -> list[BestPrice]:
    """Pick the single highest odd per outcome.

    `outcome_odds` maps an outcome label to every offer seen for it across
    bookmakers. Returns one BestPrice per outcome.
    """
    chosen: list[BestPrice] = []
    for outcome, offers in outcome_odds.items():
        if not offers:
            raise ValueError(f"No offers for outcome {outcome!r}")
        chosen.append(max(offers, key=lambda p: p.odd))
    return chosen


def arb_index(best: list[BestPrice]) -> float:
    """Sum of implied probabilities of the best prices. < 1.0 => surebet."""
    if len(best) < 2:
        raise ValueError("Need at least 2 outcomes to evaluate an arbitrage")
    return sum(implied_probability(p.odd) for p in best)


def profit_percentage(index: float) -> float:
    """Guaranteed return on total stake (percent) for a given arb index."""
    if index <= 0:
        raise ValueError("arb index must be positive")
    return (1.0 / index - 1.0) * 100.0


def split_stakes(best: list[BestPrice], total_stake: float = 1000.0) -> ArbResult:
    """Evaluate a market and, if it is a surebet, compute the optimal stake split.

    Always returns an ArbResult so callers can also inspect non-arbs (e.g. how
    close to a surebet the market is). When `is_surebet` is False the stake
    split is still returned for reference but locks in a loss.
    """
    if total_stake <= 0:
        raise ValueError("total_stake must be positive")

    index = arb_index(best)
    profit_pct = profit_percentage(index)
    is_sure = index < 1.0

    legs: list[StakeLeg] = []
    for p in best:
        ip = implied_probability(p.odd)
        stake = total_stake * ip / index
        legs.append(
            StakeLeg(
                outcome=p.outcome,
                bookmaker=p.bookmaker,
                odd=p.odd,
                implied_prob=ip,
                stake=round(stake, 2),
                stake_pct=round(100.0 * ip / index, 4),
                profit_if_wins=round(stake * p.odd - total_stake, 2),
                line=p.line,
                link=p.link,
            )
        )

    return ArbResult(
        arb_index=round(index, 6),
        profit_pct=round(profit_pct, 4),
        is_surebet=is_sure,
        legs=legs,
        total_stake=round(total_stake, 2),
    )


def evaluate_market(
    outcome_odds: dict[str, list[BestPrice]], total_stake: float = 1000.0
) -> ArbResult:
    """Convenience: pick best prices then split stakes in one call."""
    return split_stakes(best_prices(outcome_odds), total_stake=total_stake)
