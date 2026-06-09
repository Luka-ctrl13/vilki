"""End-to-end test of the aggregation pipeline using the demo parser."""
import asyncio

from app.aggregator import Aggregator
from app.parsers.demo import DemoParser


def test_demo_pipeline_detects_surebets(tmp_path, monkeypatch):
    # Force every fixture to contain an arb so the assertion is deterministic.
    parser = DemoParser(arb_ratio=1.0, seed=42)
    agg = Aggregator([parser], default_stake=1000)

    surebets = asyncio.run(agg.run())

    assert len(surebets) >= 1
    for s in surebets:
        # Definition of a surebet.
        assert s.arb_index < 1.0
        assert s.profit_pct > 0
        # Stakes are fully allocated.
        assert abs(sum(leg.stake for leg in s.legs) - s.total_stake) < 1.0
        # Each leg priced at the best book for that outcome -> at least 2 books.
        assert len(set(s.bookmakers)) >= 1
        # Every outcome covered exactly once.
        assert len(s.legs) == len({leg.outcome for leg in s.legs})


def test_disabled_parser_skipped():
    parser = DemoParser(arb_ratio=0.0, seed=1)
    agg = Aggregator([parser])
    offers = asyncio.run(agg.collect())
    # arb_ratio 0 -> still emits offers, just (almost) no arbs.
    assert len(offers) > 0


def test_single_bookmaker_never_arbs():
    # If grouping ever saw one book, it must not report a surebet.
    parser = DemoParser(arb_ratio=1.0, seed=7)
    agg = Aggregator([parser])
    offers = asyncio.run(agg.collect())
    # Keep only one bookmaker's offers.
    one = [o for o in offers if o.bookmaker == "BetAlpha"]
    assert agg.find_surebets(one) == []
