"""Bet placement automation for detected surebets.

Design goals (and safety posture):
  * One click → both legs of a surebet are placed via per-bookmaker executors.
  * PAPER mode is the default: it simulates fills and tracks P&L without touching
    real money. REAL mode is opt-in and requires the user to wire in their own
    authenticated bookmaker session (token/cookies) — this code never logs in,
    stores credentials, or tries to evade anti-bot systems.
  * Risk controls run before any placement: kill-switch, min-profit, max-stake,
    de-duplication (never bet the same opportunity twice).
  * Partial fills are the real danger of arbitrage automation: if one leg is
    accepted and the other is rejected (odds moved / market suspended), you are
    left with an unhedged position. We never silently swallow that — the bet is
    marked PARTIAL and surfaced loudly.

The actual bookmaker request lives in each RealExecutor's `_submit`, which the
operator completes for their account. Until configured, real executors refuse
to place and report why, so nothing happens by accident.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path

import httpx

from app.models import Surebet, SurebetLeg

log = logging.getLogger("betting")
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class BetStatus(str, Enum):
    SIMULATED = "SIMULATED"   # paper fill
    PLACED = "PLACED"         # both legs accepted for real
    PARTIAL = "PARTIAL"       # some legs accepted, some not -> unhedged risk!
    REJECTED = "REJECTED"     # blocked by risk controls or all legs failed
    FAILED = "FAILED"         # unexpected error


@dataclass
class LegResult:
    bookmaker: str
    outcome: str
    line: float | None
    stake: float
    requested_odd: float
    accepted_odd: float | None
    ok: bool
    message: str = ""


@dataclass
class PlacedBet:
    surebet_id: str
    event: str
    market: str
    line: float | None
    status: BetStatus
    total_stake: float
    expected_profit_pct: float
    legs: list[LegResult]
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    note: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
        return d


@dataclass
class RiskConfig:
    """Guard rails checked before every placement."""

    enabled: bool = False          # master kill-switch; off until operator turns it on
    mode: str = "paper"            # "paper" | "real"
    min_profit_pct: float = 0.5    # ignore razor-thin / likely-stale arbs
    max_stake_per_bet: float = 5000.0
    max_odd_slippage: float = 0.0  # allowed drop vs detected odd (0 = none) in real mode
    allow_partial: bool = False    # if False, a partial fill is flagged as PARTIAL risk


# --------------------------------------------------------------------------- #
# Executors: one per bookmaker. They turn a leg into an accepted/declined bet. #
# --------------------------------------------------------------------------- #
class BetExecutor(ABC):
    bookmaker: str = "base"

    @abstractmethod
    async def place(self, leg: SurebetLeg) -> LegResult:
        ...


class PaperExecutor(BetExecutor):
    """Simulates a fill at the detected odd. Safe, deterministic, no I/O."""

    def __init__(self, bookmaker: str):
        self.bookmaker = bookmaker

    async def place(self, leg: SurebetLeg) -> LegResult:
        return LegResult(
            bookmaker=self.bookmaker,
            outcome=leg.outcome,
            line=leg.line,
            stake=leg.stake,
            requested_odd=leg.odd,
            accepted_odd=leg.odd,
            ok=True,
            message="paper fill",
        )


class RealExecutorBase(BetExecutor):
    """Base for real placement against the operator's authenticated session.

    Reads a session token from env (e.g. OLIMP_SESSION / ONEXBET_SESSION). If
    absent, refuses to place — real money never moves without explicit setup.
    Subclasses implement `_submit` with their bookmaker's place-bet request.
    """

    bookmaker = "base"
    session_env = ""

    def __init__(self, base_url: str, timeout: float = 12.0):
        self.base_url = base_url
        self.timeout = timeout
        self.session = os.getenv(self.session_env, "").strip()

    @property
    def configured(self) -> bool:
        return bool(self.session)

    async def place(self, leg: SurebetLeg) -> LegResult:
        base = LegResult(
            bookmaker=self.bookmaker, outcome=leg.outcome, line=leg.line,
            stake=leg.stake, requested_odd=leg.odd, accepted_odd=None, ok=False,
        )
        if not self.configured:
            base.message = (
                f"real executor not configured: set {self.session_env} to a valid "
                f"authenticated session to place real bets"
            )
            return base
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                accepted_odd, ok, msg = await self._submit(client, leg)
            base.accepted_odd = accepted_odd
            base.ok = ok
            base.message = msg
        except Exception as exc:  # noqa: BLE001
            base.message = f"placement error: {exc}"
        return base

    @abstractmethod
    async def _submit(self, client: httpx.AsyncClient, leg: SurebetLeg) -> tuple[float | None, bool, str]:
        """Submit one bet. Return (accepted_odd, ok, message).

        Operator implements the bookmaker's exact place-bet call here using
        `self.session`. Kept as a single, isolated method on purpose.
        """
        ...


class OlimpExecutor(RealExecutorBase):
    bookmaker = "Olimp"
    session_env = "OLIMP_SESSION"

    async def _submit(self, client, leg):  # pragma: no cover - operator-specific
        # TODO(operator): implement the authenticated POST to Olimp's place-bet
        # endpoint using self.session. Left unimplemented so no half-built real
        # request can fire by accident.
        return None, False, "OlimpExecutor._submit not implemented for this account"


class OneXBetExecutor(RealExecutorBase):
    bookmaker = "1xbet"
    session_env = "ONEXBET_SESSION"

    async def _submit(self, client, leg):  # pragma: no cover - operator-specific
        return None, False, "OneXBetExecutor._submit not implemented for this account"


# --------------------------------------------------------------------------- #
# Coordinator: risk checks + placing all legs + recording history.            #
# --------------------------------------------------------------------------- #
class BetCoordinator:
    def __init__(self, executors: dict[str, BetExecutor], risk: RiskConfig):
        self.executors = executors            # bookmaker -> executor
        self.risk = risk
        self.history: list[PlacedBet] = []
        self._placed_ids: set[str] = set()    # de-dup
        self._lock = asyncio.Lock()

    # ---- risk gate --------------------------------------------------------- #
    def _reject(self, sb: Surebet, reason: str) -> PlacedBet:
        bet = PlacedBet(
            surebet_id=sb.id, event=f"{sb.home} — {sb.away}", market=sb.market, line=sb.line,
            status=BetStatus.REJECTED, total_stake=sb.total_stake,
            expected_profit_pct=sb.profit_pct, legs=[], note=reason,
        )
        return bet

    def _check_risk(self, sb: Surebet, stake: float) -> str | None:
        if not self.risk.enabled:
            return "betting is disabled (kill-switch off)"
        if sb.id in self._placed_ids:
            return "already placed for this opportunity"
        if sb.profit_pct < self.risk.min_profit_pct:
            return f"profit {sb.profit_pct:.2f}% below min {self.risk.min_profit_pct:.2f}%"
        if stake > self.risk.max_stake_per_bet:
            return f"stake {stake:.0f} exceeds max {self.risk.max_stake_per_bet:.0f}"
        missing = [leg.bookmaker for leg in sb.legs if leg.bookmaker not in self.executors]
        if missing:
            return f"no executor for bookmaker(s): {', '.join(sorted(set(missing)))}"
        return None

    # ---- placement --------------------------------------------------------- #
    async def place_surebet(self, sb: Surebet, stake: float | None = None) -> PlacedBet:
        stake = stake or sb.total_stake
        async with self._lock:
            reason = self._check_risk(sb, stake)
            if reason:
                bet = self._reject(sb, reason)
                self._record(bet)
                return bet

            # Rescale stakes if operator overrides the total.
            legs = self._scaled_legs(sb, stake)
            results: list[LegResult] = []
            for leg in legs:
                executor = self.executors[leg.bookmaker]
                results.append(await executor.place(leg))

            status = self._status_from(results)
            bet = PlacedBet(
                surebet_id=sb.id, event=f"{sb.home} — {sb.away}", market=sb.market, line=sb.line,
                status=status, total_stake=round(sum(l.stake for l in results), 2),
                expected_profit_pct=sb.profit_pct, legs=results,
                note=self._note_for(status),
            )
            if status in (BetStatus.PLACED, BetStatus.SIMULATED, BetStatus.PARTIAL):
                self._placed_ids.add(sb.id)
            self._record(bet)
            return bet

    def _scaled_legs(self, sb: Surebet, stake: float) -> list[SurebetLeg]:
        if abs(stake - sb.total_stake) < 1e-6 or sb.total_stake <= 0:
            return sb.legs
        factor = stake / sb.total_stake
        return [leg.model_copy(update={"stake": round(leg.stake * factor, 2)}) for leg in sb.legs]

    @staticmethod
    def _status_from(results: list[LegResult]) -> BetStatus:
        oks = [r.ok for r in results]
        if all(oks):
            # paper executor reports a simulated fill via message
            return BetStatus.SIMULATED if all(r.message == "paper fill" for r in results) else BetStatus.PLACED
        if any(oks):
            return BetStatus.PARTIAL
        return BetStatus.REJECTED

    @staticmethod
    def _note_for(status: BetStatus) -> str:
        if status == BetStatus.PARTIAL:
            return "⚠ UNHEDGED: one leg filled, the other did not — resolve manually."
        if status == BetStatus.REJECTED:
            return "all legs failed (see leg messages)."
        return ""

    def _record(self, bet: PlacedBet) -> None:
        self.history.insert(0, bet)
        self.history = self.history[:200]
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            (DATA_DIR / "bets.json").write_text(
                json.dumps([b.to_dict() for b in self.history], ensure_ascii=False, indent=2)
            )
        except OSError:
            pass

    # ---- status ------------------------------------------------------------ #
    def status(self) -> dict:
        return {
            "enabled": self.risk.enabled,
            "mode": self.risk.mode,
            "min_profit_pct": self.risk.min_profit_pct,
            "max_stake_per_bet": self.risk.max_stake_per_bet,
            "executors": [
                {
                    "bookmaker": bk,
                    "real": isinstance(ex, RealExecutorBase),
                    "configured": ex.configured if isinstance(ex, RealExecutorBase) else True,
                }
                for bk, ex in self.executors.items()
            ],
            "placed_count": len(self._placed_ids),
            "history_count": len(self.history),
        }


def build_coordinator() -> BetCoordinator:
    """Assemble the coordinator from env. PAPER by default; REAL is opt-in."""
    mode = os.getenv("BETTING_MODE", "paper").lower()
    risk = RiskConfig(
        enabled=os.getenv("BETTING_ENABLED", "0") != "0",
        mode=mode,
        min_profit_pct=float(os.getenv("BETTING_MIN_PROFIT", "0.5")),
        max_stake_per_bet=float(os.getenv("BETTING_MAX_STAKE", "5000")),
        allow_partial=os.getenv("BETTING_ALLOW_PARTIAL", "0") != "0",
    )
    if mode == "real":
        olimp_base = os.getenv("OLIMP_BASE_URL", "https://olimpbet.kz")
        onex_base = os.getenv("ONEXBET_BASE_URL", "https://1xbet.com")
        executors: dict[str, BetExecutor] = {
            "Olimp": OlimpExecutor(olimp_base),
            "1xbet": OneXBetExecutor(onex_base),
        }
    else:
        executors = {"Olimp": PaperExecutor("Olimp"), "1xbet": PaperExecutor("1xbet")}
        # Paper-fill the demo books too, so DEMO_FALLBACK is fully clickable.
        for bk in ("BetAlpha", "OddsKing", "ProBet", "LiveLine"):
            executors[bk] = PaperExecutor(bk)
    return BetCoordinator(executors, risk)
