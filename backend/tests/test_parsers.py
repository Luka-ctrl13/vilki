"""Unit tests for the bookmaker parsers (totals & handicaps), on real shapes.

No network: documented JSON structures are fed straight into the parsers' pure
`_parse` methods, so they stay green even where the bookmakers are geo-blocked.
"""
from app.parsers.olimp import OlimpParser
from app.parsers.onexbet import OneXBetParser

# Trimmed real Olimp /api/v2/events item with TOTAL (1003) and HANDICAP (1004).
OLIMP_PAYLOAD = {
    "items": [
        {
            "id": 8142581,
            "live": True,
            "eventDate": "2026-06-09T17:00:00Z",
            "tournament": {"sportId": 100},
            "competitors": [
                {"id": 10, "name": "ДР Конго"},
                {"id": 20, "name": "Чили"},
            ],
            "homeCompetitorIds": [10],
            "probabilities": {
                "markets": [
                    {
                        "marketId": 1003,
                        "probabilities": [
                            {"outcomeTypeId": 1006, "odd": 1.8, "parameters": [{"type": "PARAMETER_VALUE", "value": "1.5"}]},
                            {"outcomeTypeId": 1007, "odd": 1.88, "parameters": [{"type": "PARAMETER_VALUE", "value": "1.5"}]},
                            {"outcomeTypeId": 1006, "odd": 2.4, "parameters": [{"type": "PARAMETER_VALUE", "value": "2.5"}]},
                            {"outcomeTypeId": 1007, "odd": 1.5, "parameters": [{"type": "PARAMETER_VALUE", "value": "2.5"}]},
                        ],
                    },
                    {
                        "marketId": 1004,
                        "probabilities": [
                            {"outcomeTypeId": 1008, "odd": 1.51, "parameters": [{"type": "PARAMETER_VALUE", "value": "1.0"}]},
                            {"outcomeTypeId": 1009, "odd": 2.36, "parameters": [{"type": "PARAMETER_VALUE", "value": "-1.0"}]},
                        ],
                    },
                ]
            },
        }
    ]
}


def test_olimp_totals_and_handicap():
    offers = OlimpParser()._parse(OLIMP_PAYLOAD, "soccer")
    by_market = {o.market: o for o in offers}
    assert set(by_market) == {"totals", "handicap"}

    totals = by_market["totals"]
    # Two lines (1.5 and 2.5), each with Over + Under.
    lines = {(s.name, s.line) for s in totals.selections}
    assert ("Over", 1.5) in lines and ("Under", 1.5) in lines
    assert ("Over", 2.5) in lines and ("Under", 2.5) in lines

    hcap = by_market["handicap"]
    # Home +1.0 stays +1.0; away -1.0 normalizes to home line +1.0.
    sides = {s.name: s.line for s in hcap.selections}
    assert sides["H1"] == 1.0
    assert sides["H2"] == 1.0  # normalized to home perspective => same line, pairs up


def test_onexbet_parse_totals_handicap_tree():
    # Mimic a GetGameZip Value with a nested GE/E event tree.
    value = {
        "I": 555,
        "O1": "Чили",
        "O2": "ДР Конго",
        "S": 1781025600,
        "GE": [
            {"G": 17, "E": [[{"T": 9, "C": 1.9, "P": 2.5}], [{"T": 10, "C": 1.95, "P": 2.5}]]},
            {"G": 2, "E": [[{"T": 7, "C": 1.8, "P": -1.0}], [{"T": 8, "C": 2.1, "P": 1.0}]]},
        ],
    }
    offers = OneXBetParser()._parse_game(value, "Чили", "ДР Конго", "soccer")
    by_market = {o.market: o for o in offers}
    assert set(by_market) == {"totals", "handicap"}

    totals = {(s.name, s.line): s.odd for s in by_market["totals"].selections}
    assert totals[("Over", 2.5)] == 1.9 and totals[("Under", 2.5)] == 1.95

    hcap = {s.name: s.line for s in by_market["handicap"].selections}
    assert hcap["H1"] == -1.0  # home -1.0
    assert hcap["H2"] == -1.0  # away +1.0 normalized to home -1.0 -> pairs up


def test_onexbet_skips_events_without_line():
    value = {"I": 1, "O1": "A", "O2": "B", "GE": [{"E": [[{"T": 9, "C": 1.9}]]}]}
    assert OneXBetParser()._parse_game(value, "A", "B", "tennis") == []
