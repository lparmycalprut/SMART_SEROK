from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

WIB = ZoneInfo("Asia/Jakarta")

R_SPIKE_MULT = 10.0
R_MIN_ABS = 50.0
ABSORB_MIN_CVD = 3.0
CONFIRM_BARS = 12
MIN_CONFIRM_BARS = 2
R_DROP = 0.5
MIN_MOVE_PCT = 5.0
FAIL_PCT = 2.0
LINE_PAD_PCT = 0.5
EXIT_PCT = 2.0
RETEST_MIN_GAP = 2
RETEST_R_MAX = 1.5
R_MON_MIN_EFFORT = 1.0
HL_MIN_SOL = 0.001
MAX_BARS = 168
WASH_WINDOW_SEC = 60
NOISE_TAGS = {"sandwich_bot", "mev_bot", "mev"}

SIG_RESISTANCE = "RESISTANCE TERBENTUK"
SIG_SUPPORT = "SUPPORT TERBENTUK"
SIG_RETEST_RES = "RETEST RESISTANCE — KEMUNGKINAN BREAKOUT"
SIG_RETEST_SUP = "RETEST SUPPORT — KEMUNGKINAN BREAKDOWN"


@dataclass(slots=True)
class Trade:
    trade_id: str
    mint: str
    maker: str
    event: str
    sol: float
    price: float
    ts: int
    tx_hash: str
    tags: tuple[str, ...] = ()
    matched: float = 0.0


@dataclass(slots=True)
class Bar:
    start: int
    open: float
    high: float
    low: float
    close: float
    cvd_clean: float
    volume_sol: float
    R: float | None
    signed_R: float | None
    partial: bool
    cum_cvd: float = 0.0
    cluster: int = 0
    high_mc: float | None = None
    low_mc: float | None = None

    @property
    def change_pct(self) -> float:
        return (self.close / self.open - 1.0) * 100.0 if self.open > 0 else 0.0


@dataclass(slots=True)
class Level:
    kind: str
    start: int
    idx: int
    low: float
    high: float
    low_mc: float | None
    high_mc: float | None
    armed: bool = False
    pending_arm: bool = False

    @property
    def line(self) -> float:
        return self.high if self.kind == "resistance" else self.low

    @property
    def line_mc(self) -> float | None:
        return self.high_mc if self.kind == "resistance" else self.low_mc


@dataclass(slots=True)
class SignalEvent:
    event_id: str
    signal: str
    mint: str
    symbol: str
    bar: Bar
    level: Level
    details: dict[str, float | int | str | None] = field(default_factory=dict)


def fmt_wib(ts: int) -> str:
    return datetime.fromtimestamp(ts, WIB).strftime("%d-%m-%Y %H:%M WIB")


def fmt_mc(value: float | None) -> str:
    if value is None or value <= 0:
        return "MC belum tersedia"
    if value >= 1e9:
        return f"${value / 1e9:.2f}B"
    if value >= 1e6:
        return f"${value / 1e6:.2f}M"
    if value >= 1e3:
        return f"${value / 1e3:.1f}K"
    return f"${value:.0f}"


def _annotate_wash(trades: list[Trade]) -> None:
    for trade in trades:
        trade.matched = 0.0
    by_wallet: dict[str, list[Trade]] = {}
    for trade in trades:
        by_wallet.setdefault(trade.maker, []).append(trade)
    for wallet_trades in by_wallet.values():
        wallet_trades.sort(key=lambda x: x.ts)
        open_lots: list[Trade] = []
        for trade in wallet_trades:
            remaining = trade.sol
            for lot in open_lots:
                if remaining <= 1e-9:
                    break
                if trade.ts - lot.ts > WASH_WINDOW_SEC or trade.event == lot.event:
                    continue
                available = lot.sol - lot.matched
                if available <= 1e-9:
                    continue
                matched = min(remaining, available)
                lot.matched += matched
                trade.matched += matched
                remaining -= matched
            if trade.sol - trade.matched > 1e-9:
                open_lots.append(trade)
            open_lots = [lot for lot in open_lots if trade.ts - lot.ts <= WASH_WINDOW_SEC and lot.sol - lot.matched > 1e-9]


def build_bars(trades: list[Trade], now_ts: int, bar_sec: int = 3600, mc_per_price: float = 0.0) -> list[Bar]:
    ordered = sorted(trades, key=lambda x: x.ts)
    _annotate_wash(ordered)
    maker_tags: dict[str, set[str]] = {}
    for trade in ordered:
        maker_tags.setdefault(trade.maker, set()).update(trade.tags)
    buckets: dict[int, list[Trade]] = {}
    for trade in ordered:
        start = (trade.ts // bar_sec) * bar_sec
        buckets.setdefault(start, []).append(trade)
    bars: list[Bar] = []
    cumulative = 0.0
    cluster = 0
    previous_start: int | None = None
    for start, items in sorted(buckets.items()):
        priced = [x for x in items if x.price > 0]
        if not priced:
            continue
        real = [x for x in priced if x.sol >= HL_MIN_SOL] or priced
        cvd_clean = 0.0
        volume = 0.0
        for trade in items:
            sign = 1.0 if trade.event == "buy" else -1.0
            noise = any(tag in NOISE_TAGS for tag in maker_tags.get(trade.maker, set()))
            removed = trade.sol if noise else trade.matched
            cvd_clean += sign * max(0.0, trade.sol - removed)
            volume += trade.sol
        open_price, close_price = priced[0].price, priced[-1].price
        change = (close_price / open_price - 1.0) * 100.0 if open_price > 0 else 0.0
        r_abs = abs(cvd_clean) / abs(change) if abs(change) > 1e-9 else None
        signed = None if r_abs is None else (r_abs if cvd_clean >= 0 else -r_abs)
        cumulative += cvd_clean
        if previous_start is not None and start - previous_start > 6 * bar_sec:
            cluster += 1
        high, low = max(x.price for x in real), min(x.price for x in real)
        bars.append(Bar(
            start, open_price, high, low, close_price, cvd_clean, volume, r_abs, signed,
            start + bar_sec > now_ts, cumulative, cluster,
            high * mc_per_price if mc_per_price > 0 else None,
            low * mc_per_price if mc_per_price > 0 else None,
        ))
        previous_start = start

    # content.js membatasi 168 bar sebelum cumCVD/cluster final dihitung.
    bars = bars[-MAX_BARS:]
    cumulative = 0.0
    cluster = 0
    previous_start = None
    for bar in bars:
        if previous_start is not None and bar.start - previous_start > 6 * bar_sec:
            cluster += 1
        cumulative += bar.cvd_clean
        bar.cum_cvd = cumulative
        bar.cluster = cluster
        previous_start = bar.start
    return bars


def latest_cluster(bars: list[Bar], min_cluster_bars: int = 4) -> list[Bar]:
    if len(bars) <= 1:
        return bars[:]
    starts = [0]
    for index in range(1, len(bars)):
        if bars[index].cluster != bars[index - 1].cluster:
            starts.append(index)
    start = starts[-1]
    if len(bars) - start < min_cluster_bars and len(starts) >= 2:
        start = starts[-2]
    return bars[start:]


def _r_abs(bar: Bar | None) -> float | None:
    return None if bar is None or bar.R is None else abs(bar.R)


def _baseline(bars: list[Bar]) -> float | None:
    values = [abs(x.R) for x in bars if not x.partial and x.R is not None and abs(x.cvd_clean) >= R_MON_MIN_EFFORT]
    return statistics.median(values) if len(values) >= 4 else None


def _absorption(bars: list[Bar], index: int) -> tuple[str, float] | None:
    if index == 0:
        return None
    bar, previous = bars[index], bars[index - 1]
    now_r, previous_r = _r_abs(bar), _r_abs(previous)
    if bar.partial or now_r is None or previous_r is None or previous_r <= 1e-9:
        return None
    multiple = now_r / previous_r
    if abs(bar.cvd_clean) < ABSORB_MIN_CVD or multiple < R_SPIKE_MULT or now_r < R_MIN_ABS:
        return None
    return ("resistance" if bar.cvd_clean >= 0 else "support", multiple)


def _verify(bars: list[Bar], index: int, kind: str) -> dict[str, float | int | str] | None:
    setup = bars[index]
    after = [x for x in bars[index + 1:index + 1 + CONFIRM_BARS] if not x.partial]
    if len(after) < MIN_CONFIRM_BARS:
        return None
    is_resistance = kind == "resistance"
    extreme = setup.close
    extreme_index = 0
    base_r = _r_abs(setup) or 0.0
    best: dict[str, float | int | str] | None = None
    for k, current in enumerate(after):
        value = current.low if is_resistance else current.high
        if (is_resistance and value < extreme) or (not is_resistance and value > extreme):
            extreme, extreme_index = value, k
        if k + 1 >= MIN_CONFIRM_BARS:
            move_pct = (extreme / setup.close - 1.0) * 100.0
            at_extreme = after[extreme_index]
            cvd_delta = at_extreme.cum_cvd - setup.cum_cvd
            r_values = [_r_abs(x) for x in after[:extreme_index + 1]]
            valid_r = [x for x in r_values if x is not None]
            r_after = statistics.median(valid_r) if valid_r else None
            collapsed = r_after is not None and base_r > 0 and r_after <= base_r * R_DROP
            best = {"move_pct": move_pct, "cvd_delta": cvd_delta, "r_after": r_after or 0.0,
                    "r_base": base_r, "proof_bars": k + 1, "move_bars": extreme_index + 1}
            confirmed = collapsed and ((is_resistance and cvd_delta < 0 and move_pct <= -MIN_MOVE_PCT)
                                          or (not is_resistance and cvd_delta > 0 and move_pct >= MIN_MOVE_PCT))
            if confirmed:
                best["status"] = "confirmed"
                return best
        if is_resistance and current.close > setup.high * (1 + FAIL_PCT / 100):
            return {"status": "failed"}
        if not is_resistance and (setup.low / current.close - 1.0) * 100.0 > FAIL_PCT:
            return {"status": "failed"}
    if best:
        best["status"] = "pending"
    return best


def _touches(bar: Bar, level: Level) -> bool:
    pad = level.line * LINE_PAD_PCT / 100.0
    return bar.high >= level.line - pad and bar.low <= level.line + pad


def scan_smart_serok(mint: str, symbol: str, input_bars: list[Bar]) -> tuple[list[SignalEvent], list[Level]]:
    bars = latest_cluster(input_bars)
    events: list[SignalEvent] = []
    levels: list[Level] = []
    baseline = _baseline(bars)
    for index, bar in enumerate(bars):
        candidate = _absorption(bars, index)
        if candidate:
            kind, multiple = candidate
            proof = _verify(bars, index, kind)
            if proof and proof.get("status") == "confirmed":
                level = Level(kind, bar.start, index, bar.low, bar.high, bar.low_mc, bar.high_mc)
                levels.append(level)
                signal = SIG_RESISTANCE if kind == "resistance" else SIG_SUPPORT
                events.append(SignalEvent(
                    f"{mint}:{bar.start}:{signal}", signal, mint, symbol, bar, level,
                    {**proof, "r_multiple": multiple, "setup_r": bar.signed_R},
                ))

        if bar.partial:
            continue
        for level in levels:
            if level.idx >= index:
                continue
            if level.pending_arm:
                level.armed = True
                level.pending_arm = False

        if baseline is not None and bar.R is not None and abs(bar.cvd_clean) >= ABSORB_MIN_CVD and index > 0:
            r_norm = abs(bar.R) / baseline if baseline > 1e-9 else None
            previous = bars[index - 1]
            cvd_up = bar.cum_cvd > previous.cum_cvd
            if r_norm is not None and r_norm <= RETEST_R_MAX:
                for level in levels:
                    if index - level.idx < RETEST_MIN_GAP or not level.armed or not _touches(bar, level):
                        continue
                    if level.kind == "resistance" and not cvd_up:
                        continue
                    if level.kind == "support" and cvd_up:
                        continue
                    level.armed = False
                    signal = SIG_RETEST_RES if level.kind == "resistance" else SIG_RETEST_SUP
                    events.append(SignalEvent(
                        f"{mint}:{level.start}:{bar.start}:{signal}", signal, mint, symbol, bar, level,
                        {"r_norm": r_norm, "r_baseline": baseline, "cvd_direction": "naik" if cvd_up else "turun"},
                    ))
                    break
        for level in levels:
            if level.idx < index and abs(bar.close / level.line - 1.0) * 100.0 >= EXIT_PCT:
                level.pending_arm = True
    return events, levels


def event_message(event: SignalEvent) -> str:
    icon = "🔴" if event.signal == SIG_RESISTANCE else "🟢" if event.signal == SIG_SUPPORT else "🔵" if event.signal == SIG_RETEST_RES else "🟠"
    lines = [f"{icon} {event.signal}", "", f"Token: {event.symbol}", f"Mint: {event.mint}", "TF: 1H",
             f"Garis: {fmt_mc(event.level.line_mc)}", f"Waktu: {fmt_wib(event.bar.start)}"]
    if event.signal in {SIG_RESISTANCE, SIG_SUPPORT}:
        lines += [f"R setup: {float(event.details.get('setup_r') or 0):+.2f}",
                  f"Lonjakan R: {float(event.details.get('r_multiple') or 0):.1f}× bar sebelumnya",
                  f"Bukti harga: {float(event.details.get('move_pct') or 0):+.1f}%",
                  f"ΔcumCVD: {float(event.details.get('cvd_delta') or 0):+.1f} SOL"]
    else:
        lines += [f"Level asal: {fmt_wib(event.level.start)}",
                  f"R retest: {float(event.details.get('r_norm') or 0):.2f}× acuan",
                  f"cumCVD: {event.details.get('cvd_direction')}", "Penjaga level tidak hadir berarti."]
    lines += ["", "Auto-trade: OFF"]
    return "\n".join(lines)
