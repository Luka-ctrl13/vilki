"""Unit tests for the bookmaker parsers, using real captured response shapes.

These don't hit the network — they feed the documented JSON structure straight
into the parsers' pure `_parse` methods, so they stay green even where the
bookmakers are geo-blocked.
"""
from app.parsers.olimp import OlimpParser
from app.parsers.onexbet import OneXBetParser

# Trimmed real Olimp /api/v2/events item (football, 1X2).
OLIMP_PAYLOAD = {
    "items": [
        {
            "id": 8142581,
            "live": True,
            "eventDate": "2026-06-09T17:00:00Z",
            "tournament": {"sportId": 100},
            "competitors": [
                {"id": 10, "name": "ДР Конго", "type": "TEAM"},
                {"id": 20, "name": "Чили", "type": "TEAM"},
            ],
            "homeCompetitorIds": [10],
            "probabilities": {
                "markets": [
                    {
                        "marketId": 1000,
                        "probabilities": [
                            {"outcomeTypeId": 1002, "odd": 1.36},
                            {"outcomeTypeId": 1001, "odd": 3.75},
                            {"outcomeTypeId": 1000, "odd": 12.5},
                        ],
                    },
                    {"marketId": 1003, "probabilities": []},
                ]
            },
        }
    ]
}

# Trimmed real 1xbet LiveFeed Get1x2_VZip Value item.
ONEXBET_PAYLOAD = {
    "Success": True,
    "Value": [
        {
            "I": 123456789,
            "O1": "Чили",
            "O2": "ДР Конго",
            "S": 1781025600,
            "E": [
                {"T": 1, "C": 2.10},
                {"T": 2, "C": 3.40},
                {"T": 3, "C": 3.10},
            ],
        }
    ],
}


def test_olimp_parse_1x2():
    offers = OlimpParser()._parse(OLIMP_PAYLOAD, "soccer")
    assert len(offers) == 1
    o = offers[0]
    assert o.bookmaker == "Olimp"
    assert o.sport == "soccer"
    assert o.home == "ДР Конго" and o.away == "Чили"
    assert o.is_live is True
    odds = {s.name: s.odd for s in o.selections}
    assert odds == {"1": 12.5, "X": 3.75, "2": 1.36}


def test_onexbet_parse_1x2():
    offers = OneXBetParser()._parse(ONEXBET_PAYLOAD, "soccer")
    assert len(offers) == 1
    o = offers[0]
    assert o.bookmaker == "1xbet"
    assert o.home == "Чили" and o.away == "ДР Конго"
    odds = {s.name: s.odd for s in o.selections}
    assert odds == {"1": 2.10, "X": 3.40, "2": 3.10}


def test_event_keys_match_across_books():
    # The whole point: same fixture must map to the same key in both books so the
    # aggregator can compare their odds for an arbitrage (despite home/away swap).
    olimp = OlimpParser()._parse(OLIMP_PAYLOAD, "soccer")[0]
    onex = OneXBetParser()._parse(ONEXBET_PAYLOAD, "soccer")[0]
    assert olimp.event_key == onex.event_key


def test_onexbet_skips_incomplete_market():
    payload = {"Value": [{"I": 1, "O1": "A", "O2": "B", "E": [{"T": 1, "C": 1.9}]}]}
    assert OneXBetParser()._parse(payload, "tennis") == []


def test_olimp_ignores_suspended_or_bad_odds():
    payload = {
        "items": [
            {
                "id": 1,
                "competitors": [{"id": 1, "name": "A"}, {"id": 2, "name": "B"}],
                "homeCompetitorIds": [1],
                "probabilities": {
                    "markets": [
                        {
                            "marketId": 1000,
                            "probabilities": [
                                {"outcomeTypeId": 1000, "odd": 1.0},  # invalid (<=1)
                                {"outcomeTypeId": 1002, "odd": 1.8},
                            ],
                        }
                    ]
                },
            }
        ]
    }
    # Only one valid selection -> not enough for a market -> dropped.
    assert OlimpParser()._parse(payload, "tennis") == []
