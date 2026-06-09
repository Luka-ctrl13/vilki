"""Tests for the arbitrage engine. The math here is what makes or breaks the product."""
import math

import pytest

from app.arbitrage import (
    BestPrice,
    arb_index,
    best_prices,
    evaluate_market,
    implied_probability,
    profit_percentage,
    split_stakes,
)


def test_implied_probability():
    assert implied_probability(2.0) == pytest.approx(0.5)
    assert implied_probability(4.0) == pytest.approx(0.25)
    with pytest.raises(ValueError):
        implied_probability(1.0)
    with pytest.raises(ValueError):
        implied_probability(0.5)


def test_best_prices_picks_highest_per_outcome():
    odds = {
        "1": [BestPrice("1", "A", 2.1), BestPrice("1", "B", 2.3), BestPrice("1", "C", 1.9)],
        "2": [BestPrice("2", "A", 1.8), BestPrice("2", "B", 2.05)],
    }
    best = {p.outcome: p for p in best_prices(odds)}
    assert best["1"].bookmaker == "B" and best["1"].odd == 2.3
    assert best["2"].bookmaker == "B" and best["2"].odd == 2.05


def test_single_bookmaker_overround_is_not_a_surebet():
    # A real bookmaker prices a coin-flip with margin: 1.9 / 1.9 -> index ~1.05
    best = [BestPrice("1", "A", 1.9), BestPrice("2", "A", 1.9)]
    idx = arb_index(best)
    assert idx > 1.0
    res = split_stakes(best)
    assert res.is_surebet is False
    assert res.profit_pct < 0


def test_two_way_surebet():
    # Best prices from two bookmakers create an arbitrage.
    odds = {
        "1": [BestPrice("1", "A", 2.10), BestPrice("1", "B", 1.95)],
        "2": [BestPrice("2", "A", 1.90), BestPrice("2", "B", 2.10)],
    }
    res = evaluate_market(odds, total_stake=1000)
    # index = 1/2.10 + 1/2.10 = 0.95238...
    assert res.arb_index == pytest.approx(0.952381, abs=1e-5)
    assert res.is_surebet is True
    assert res.profit_pct == pytest.approx(5.0, abs=0.01)
    # Both bets must come from the bookmaker offering 2.10.
    assert all(leg.odd == 2.10 for leg in res.legs)


def test_stakes_lock_in_equal_return():
    odds = {
        "1": [BestPrice("1", "A", 2.10)],
        "2": [BestPrice("2", "B", 2.10)],
    }
    res = evaluate_market(odds, total_stake=1000)
    assert sum(leg.stake for leg in res.legs) == pytest.approx(1000, abs=0.01)
    # Whichever outcome wins, the return is identical.
    returns = [leg.stake * leg.odd for leg in res.legs]
    assert returns[0] == pytest.approx(returns[1], abs=0.5)
    # And it exceeds the total stake => guaranteed profit.
    assert returns[0] > 1000


def test_three_way_football_surebet():
    # 1X2 market combined across three bookmakers.
    odds = {
        "1": [BestPrice("1", "A", 3.5)],
        "X": [BestPrice("X", "B", 3.8)],
        "2": [BestPrice("2", "C", 3.6)],
    }
    res = evaluate_market(odds, total_stake=900)
    expected_index = 1 / 3.5 + 1 / 3.8 + 1 / 3.6
    assert res.arb_index == pytest.approx(round(expected_index, 6))
    assert res.is_surebet is True
    assert len(res.legs) == 3
    assert sum(leg.stake for leg in res.legs) == pytest.approx(900, abs=0.05)


def test_three_way_no_arb():
    odds = {
        "1": [BestPrice("1", "A", 2.5)],
        "X": [BestPrice("X", "B", 3.0)],
        "2": [BestPrice("2", "C", 2.5)],
    }
    res = evaluate_market(odds)
    assert res.is_surebet is False


def test_profit_percentage_matches_index():
    assert profit_percentage(0.95) == pytest.approx((1 / 0.95 - 1) * 100)
    assert profit_percentage(1.05) < 0


def test_requires_at_least_two_outcomes():
    with pytest.raises(ValueError):
        arb_index([BestPrice("1", "A", 2.0)])


def test_invalid_total_stake():
    odds = {"1": [BestPrice("1", "A", 2.1)], "2": [BestPrice("2", "B", 2.1)]}
    with pytest.raises(ValueError):
        evaluate_market(odds, total_stake=0)
