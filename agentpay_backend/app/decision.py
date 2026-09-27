"""
Dispute WATCHDOG - not a decision-maker.

Role of this module after the parametric-insurance pivot:

  * The payout amount is decided by formula.py, full stop. Nothing in here
    returns, adjusts or approves an amount.
  * The AI only wakes up when two or more independent sources disagree
    beyond a tolerance (formula.sources_disagree). The floor payout has
    ALREADY been sent on-chain by the time we're called; only the
    ceiling-minus-floor delta is sitting in escrow.
  * Sources can be in different units: rainfall totals (mm) from two
    weather models, and optionally a satellite crop-health vote (NDVI).
    Every reading arrives with its payout ratio already computed by main.py
    from the policy's mapping for that unit, so the watchdog compares
    *ratios*, and it is expected to cross-reference the satellite against
    the weather ("weather models say drought, but the field is still
    green") - that is a far stronger explanation than weather-vs-weather.
  * What it does: investigate why the sources disagree, cross-reference
    them for signs of a sensor fault / manipulation, explain the situation
    in plain language, and recommend one of two things:
        "auto_resolve" -> dispute_status = investigating; the next evaluate
                          cycle may settle the escrow from fresh readings
        "escalate"     -> dispute_status = escalated; a human must call
                          POST /policy/{id}/resolve
  * What it can NOT do: release or void the escrow, or send a payment. The
    DisputeReport it returns carries no amounts at all, and main.py never
    reads anything from it except the recommendation + text for display.

A deterministic guardrail sits on top of the AI: a spread of
HARD_ESCALATE_SPREAD or more is always escalated, whatever the model says.
If no API key is configured (or the call fails) a rule-based investigator
produces the same DisputeReport shape so the demo never depends on the
model being reachable.
"""

import json
import os
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.formula import DEFAULT_TOLERANCE, payout_amount, payout_ratio
from app.models import DisputeReport, Policy, SourceReading
from app.products import PRODUCTS

# Spread (highest - lowest payout ratio) at/above which a case is always flagged for audit.
HARD_ESCALATE_SPREAD = 0.40

WATCHDOG_MODEL = os.environ.get("WATCHDOG_MODEL", "claude-opus-5")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b"  # llama-3.3-70b-versatile left Groq's free tier


def _secret(name: str) -> str:
    """Environment first, then the gitignored .env next to app/ (same discipline as the other keys)."""
    val = os.environ.get(name, "").strip()
    if val:
        return val
    try:
        for line in (Path(__file__).resolve().parent.parent / ".env").read_text(encoding="utf-8").splitlines():
            key, _, value = line.partition("=")
            if key.strip() == name:
                return value.strip().strip("'\"")
    except OSError:
        pass
    return ""

def system_prompt(ctx: "DisputeContext") -> str:
    """Built from the policy's own catalog entry (label, metric, unit); crop-only language (satellite NDVI) appears
    only when a satellite reading is actually part of the dispute."""
    sources = f"independent readings of the policy's own metric, {ctx.metric.lower()} (in {ctx.unit})"
    if ctx.satellite:
        sources += (" and a satellite vegetation-index reading of the field itself (NDVI, where roughly 0.6+ is a healthy canopy and "
                    "below 0.3 is bare or dead vegetation)")
    if ctx.status:
        sources += " and status-type evidence from an independent domain"
    lines = [
        f"You are the dispute watchdog for a parametric insurance contract ({ctx.label}) on Solana devnet.",
        "",
        "Context you must respect:",
        "- The payout is computed by a fixed formula from observed readings. You do not set, adjust or approve any amount, and you must not suggest one.",
        f"- Two or more independent sources for the same policy and window disagree beyond tolerance. Sources here: {sources}. Each reading has already been mapped to a payout ratio with the policy's own thresholds, so compare the ratios.",
        "- The payout is the median of the sources' payout ratios (the middle reading), paid in full on-chain at once. Nothing is held back and nobody approves it: your text cannot change or delay any payment. Do not state amounts; the app states what was paid.",
    ]
    if ctx.status:
        lines.append("- Status readings (unit status, e.g. ticketmaster_event_status) are independent non-measurement evidence: cancelled/postponed = ratio 1.0, still going ahead = 0.0.")
    lines.append(
        "- Your job: work out why the sources disagree, look for signs of a sensor fault, data outage or manipulation (for example one source reporting exactly zero while another reports a large value, "
        "a reading that is implausible for the place or situation, or a spread far larger than normal variance between independent providers), explain the situation in plain language a non-technical reviewer can act on, "
        "and recommend either \"auto_resolve\" (the disagreement looks like ordinary variance) or \"escalate\" (it looks like a fault or manipulation worth auditing afterwards; this only flags the case, it does not stop or change the payment).")
    if ctx.satellite and ctx.measured:
        lines.append(f"- A satellite reading is present: cross-reference it explicitly against the {ctx.metric.lower()} readings: they measure the cause, the satellite measures the outcome (crop health). "
                     "Spell out any conflict between them, naming the satellite reading and its date.")
    lines.append("- Prefer \"escalate\" whenever manipulation or a fault is plausible. Be concrete in the evidence list: cite the actual numbers you were given.")
    lines.append("- Readings marked SIMULATED / injected are demo values chosen on purpose for a demonstration. Judge them as if they were real readings: being simulated is not itself a sign of a fault or manipulation, so do not mention it.")
    banned = [w for w in PLAIN_BANNED if w != "NDVI" or ctx.satellite]
    lines.append("- Also write plain_summary for the policyholder, someone with no technical, insurance or crypto knowledge: 2-3 short sentences in everyday words, addressing them as \"you\". "
                 f"Say what each source reported (numbers with their unit, {ctx.unit}, are fine), why the different answers matter in real life, that the app paid by the middle report, so nothing waits and nobody has to approve it, and what that meant for them: nothing owed, part of the cover (a percentage is fine) or all of it. "
                 "Name the middle report with its value and say where it sits against the rule, using the 'In plain words' line of the context (for example: the middle report was X, short of the point where payment starts, so nothing is paid). "
                 "Do not mention money amounts or SOL (the app shows them from the real numbers), and never use these words: " + ", ".join(banned) + ".")
    return "\n".join(lines)


PLAIN_BANNED = ("payout ratio", "ratio", "spread", "floor", "ceiling", "delta", "escrow", "variance", "tolerance", "median", "NDVI", "simulated", "injected", "oracle")
_PLAIN_BAD = re.compile(r"\b(" + "|".join(re.escape(w) for w in PLAIN_BANNED) + r"|SOL)\b", re.I)


def _plain(text: object) -> str:
    """The customer-facing sentences, or "" if the model ignored the rules (then the UI uses its own wording)."""
    t = " ".join(str(text or "").split())
    return "" if not t or len(t) > 500 or _PLAIN_BAD.search(t) else t


REPORT_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "2-4 plain-language sentences for the reviewer"},
        "plain_summary": {"type": "string", "description": "2-3 jargon-free sentences for the policyholder, no money amounts"},
        "suspected_cause": {"type": "string", "description": "short label, e.g. 'model spread', 'sensor dropout', 'possible manipulation', 'weather vs satellite conflict'"},
        "evidence": {"type": "array", "items": {"type": "string"}, "description": "3-6 concrete, checkable points"},
        "recommendation": {"type": "string", "enum": ["auto_resolve", "escalate"]},
    },
    "required": ["summary", "plain_summary", "suspected_cause", "evidence", "recommendation"],
    "additionalProperties": False,
}


def _ratio(policy: Policy, r: SourceReading) -> float:
    """Reading -> payout ratio. main.py normally pre-fills r.payout_ratio;
    recompute from the policy mapping when it didn't."""
    if r.payout_ratio is not None:
        return float(r.payout_ratio)
    if r.unit == "ndvi":
        return payout_ratio(r.observed_mm, policy.ndvi_trigger, policy.ndvi_exit)
    if r.unit == "status":
        return r.observed_mm  # implied ratio
    return payout_ratio(r.observed_mm, policy.trigger_mm, policy.exit_mm)


def _fmt(r: SourceReading) -> str:
    if r.unit == "status":
        return f"event status '{r.status}'"
    return f"NDVI {r.observed_mm:.2f}" if r.unit == "ndvi" else f"{r.observed_mm:.1f} {r.unit}"


@dataclass
class DisputeContext:
    policy: Policy
    readings: list[SourceReading]
    floor_ratio: float
    ceiling_ratio: float
    paid_ratio: float | None = None   # None = an escrow cycle from before median settlement: the floor was paid

    @property
    def spread(self) -> float:
        return self.ceiling_ratio - self.floor_ratio

    @property
    def measured(self) -> list[SourceReading]:
        """Readings of the policy's own metric (rainfall mm, delay min, ...): everything except satellite and status evidence."""
        return [r for r in self.readings if r.unit not in ("ndvi", "status")]

    @property
    def label(self) -> str:
        return PRODUCTS.get(self.policy.product_type, {}).get("label", "parametric cover")

    @property
    def subject(self) -> str:
        return PRODUCTS.get(self.policy.product_type, {}).get("subject", "the insured subject")

    @property
    def metric(self) -> str:
        return self.policy.metric_label

    @property
    def unit(self) -> str:
        return self.policy.metric_unit

    @property
    def noun(self) -> str:
        return self.policy.metric_label.lower()

    @property
    def status(self) -> list[SourceReading]:
        return [r for r in self.readings if r.unit == "status"]

    @property
    def floor_amount(self) -> float:
        return payout_amount(self.policy.sum_insured_sol, self.floor_ratio)

    @property
    def ceiling_amount(self) -> float:
        return payout_amount(self.policy.sum_insured_sol, self.ceiling_ratio)

    @property
    def paid(self) -> float:
        return self.floor_ratio if self.paid_ratio is None else self.paid_ratio

    @property
    def paid_amount(self) -> float:
        return payout_amount(self.policy.sum_insured_sol, self.paid)

    def paid_clause(self) -> str:
        """What was actually paid, from the real numbers. The only money statement a report may contain."""
        if self.paid_ratio is None:
            return (f"{self.paid_amount:.4f} SOL was paid at once; the rest is still held from an earlier cycle" if self.paid_amount > 0
                    else "Nothing has been paid yet; the rest is still held from an earlier cycle")
        if self.paid_amount > 0:
            return f"{self.paid_amount:.4f} SOL (the middle reading, ratio {self.paid:.3f}) was paid in full at once; nothing is held back"
        return "The middle reading means nothing is owed, so nothing was paid"

    def middle_reading(self) -> str | None:
        """The middle report in the policy's own unit, when it is one of the measured readings (odd count, no
        satellite/status votes); otherwise None and the explanation talks about shares of the cover instead."""
        if len(self.measured) != len(self.readings) or len(self.measured) % 2 == 0:
            return None
        vals = sorted(r.observed_mm for r in self.measured)
        return f"{vals[len(vals) // 2]:g} {self.unit}"

    def paid_position(self) -> str:
        """Where the paid result sits against the rule, in words a policyholder can follow."""
        p = self.policy
        if self.paid <= 0:
            return f"does not reach the {p.trigger_mm:g} {self.unit} point where payment starts"
        if self.paid >= 1:
            return f"reaches the {p.exit_mm:g} {self.unit} point where you get everything"
        return f"is between {p.trigger_mm:g} {self.unit}, where payment starts, and {p.exit_mm:g} {self.unit}, where you get everything"

    @property
    def satellite(self) -> list[SourceReading]:
        return [r for r in self.readings if r.unit == "ndvi"]

    def describe(self) -> str:
        p = self.policy
        direction = f"higher {self.noun} = more loss" if p.exit_mm > p.trigger_mm else f"lower {self.noun} = more loss"
        lines = [
            f"Policy {p.id}: {self.label}, insuring {self.subject}; location {p.region} (lat {p.lat}, lon {p.lon}), window {p.window_start} to {p.window_end}; {direction}.",
            f"{self.metric} mapping: trigger {p.trigger_mm:g} {self.unit} (no loss), exit {p.exit_mm:g} {self.unit} (total loss).",
        ]
        if self.satellite:
            lines.append(f"Satellite mapping: NDVI trigger {p.ndvi_trigger} (healthy, no loss), exit {p.ndvi_exit} (total loss).")
        lines.append("Readings:")
        for r in self.readings:
            live = "live API" if r.live else "SIMULATED / injected"
            when = f", captured {r.captured_at}" if r.captured_at else ""
            lines.append(f"  - {r.source}: {_fmt(r)} -> payout ratio {_ratio(p, r):.3f} ({live}{when}). {r.detail}".rstrip())
        if self.measured and self.satellite:
            w = sum(_ratio(p, r) for r in self.measured) / len(self.measured)
            s = _ratio(p, self.satellite[0])
            lines.append(
                f"Cross-reference: the {self.noun} readings imply an average payout ratio of {w:.3f}; "
                f"the satellite crop-health reading implies {s:.3f}."
            )
        if self.status:
            lines.append("Status sources (e.g. ticketmaster_event_status) are not continuous values: a cancelled/postponed event implies ratio 1.0, an event still going ahead implies 0.0.")
        lines.append(
            f"Lowest payout ratio {self.floor_ratio:.3f}, highest {self.ceiling_ratio:.3f}, spread {self.spread:.3f}. "
            f"Payout = the median ratio {self.paid:.3f} = {self.paid_amount:.4f} SOL, paid in full at once; nothing is held."
        )
        mid = self.middle_reading()
        lines.append(f"In plain words: the middle report is {mid}; it {self.paid_position()}." if mid
                     else f"In plain words: the middle result {self.paid_position()}.")
        return "\n".join(lines)


_SENT = re.compile(r"(?<=[a-z0-9)%])[.;]" + chr(92) + "s+(?=[A-Z])|" + chr(92) + "n")
# Any sentence that talks about paying, holding or releasing money. The model is told not to; if it does anyway
# the sentence is dropped, and the one money statement in a report is always ctx.paid_clause() from the real numbers.
_MONEY = re.compile(r"\b(floor|ceiling|escrow|held|hold|holds|delta|paid|pays?|payment|releas\w*|void\w*)\b", re.I)


def _guardrail(report: DisputeReport, ctx: DisputeContext) -> DisputeReport:
    """Deterministic overrides applied to every provider's report: the only statement about money is the real one,
    and a big spread is always flagged for audit (it never stops or changes the payment)."""
    sentences = [s.strip() for s in _SENT.split(unicodedata.normalize("NFKC", report.summary)) if s.strip()]
    kept = [s if s.endswith((".", "!", "?")) else s + "." for s in sentences if not _MONEY.search(s)]
    report.summary = " ".join(kept + [f"{ctx.paid_clause()}."])
    report.evidence = [e for e in report.evidence if not re.search(r"\b(escrow|held|releas\w*|void\w*|paid)\b", e, re.I)]
    report.evidence.append(f"Paid: middle ratio {ctx.paid:.3f} = {ctx.paid_amount:.4f} SOL" + (", in full, at once" if ctx.paid_ratio is not None else ""))
    if ctx.spread >= HARD_ESCALATE_SPREAD and report.recommendation != "escalate":
        report.recommendation = "escalate"
        report.evidence.append(
            f"Guardrail: spread {ctx.spread:.2f} is at/above the hard limit {HARD_ESCALATE_SPREAD:.2f}; flagged for audit regardless of the model's view."
        )
    return report


def investigate_heuristic(ctx: DisputeContext) -> DisputeReport:
    """Rule-based fallback with the same shape as the AI report. Runs when no provider key is set, or when
    every provider fails. Every branch works on payout RATIOS (the product-independent quantity) and reads its
    vocabulary from the policy's own catalog entry, so it is correct for any product and never contradicts
    the deterministic guardrail (which escalates any spread >= HARD_ESCALATE_SPREAD)."""
    p = ctx.policy
    least_loss = min(ctx.readings, key=lambda r: _ratio(p, r))
    most_loss = max(ctx.readings, key=lambda r: _ratio(p, r))
    evidence = [
        f"{r.source} reports {_fmt(r)} -> payout ratio {_ratio(p, r):.2f} ({'live' if r.live else 'simulated'}"
        f"{', captured ' + r.captured_at if r.captured_at else ''})"
        for r in ctx.readings
    ]
    evidence.append(f"Payout ratio spread is {ctx.spread:.2f} (tolerance {DEFAULT_TOLERANCE:.2f})")

    measured, satellite = ctx.measured, ctx.satellite
    if measured and satellite:
        sat = satellite[0]
        m_ratio = sum(_ratio(p, r) for r in measured) / len(measured)
        s_ratio = _ratio(p, sat)
        m_txt = " and ".join(f"{r.source} ({_fmt(r)})" for r in measured)
        when = f" captured {sat.captured_at}" if sat.captured_at else ""
        if abs(m_ratio - s_ratio) > DEFAULT_TOLERANCE:
            evidence.append(f"{ctx.metric} readings imply ratio {m_ratio:.2f}; satellite implies {s_ratio:.2f}")
            if m_ratio > s_ratio:
                summary = (
                    f"The {ctx.noun} readings ({m_txt}) suggest a significant loss (payout ratio about {m_ratio:.2f}), "
                    f"but satellite imagery of the field{when} shows vegetation that is still healthy "
                    f"(NDVI {sat.observed_mm:.2f}, ratio {s_ratio:.2f}). A {ctx.noun} reading that did not translate into crop damage, "
                    "or a data feed that overstates the event, is worth an audit."
                )
            else:
                summary = (
                    f"Satellite imagery of the field{when} shows stressed or missing vegetation "
                    f"(NDVI {sat.observed_mm:.2f}, ratio {s_ratio:.2f}) while the {ctx.noun} readings ({m_txt}) "
                    f"suggest little or no loss (ratio about {m_ratio:.2f}). The damage may have a cause the {ctx.noun} "
                    "index does not capture (heat, pests, a different field), so the imagery is worth an audit."
                )
            return _guardrail(
                DisputeReport(summary=summary, suspected_cause=f"{ctx.noun} vs satellite conflict", evidence=evidence,
                              recommendation="escalate", ai_used=False, model="heuristic"),
                ctx,
            )

    if ctx.status:
        st = ctx.status[0]
        others = [r for r in ctx.readings if r.unit != "status"]
        o_ratio = sum(_ratio(p, r) for r in others) / len(others) if others else 0.0
        s_ratio = _ratio(p, st)
        o_txt = " and ".join(f"{r.source} ({_fmt(r)})" for r in others) or "no other source"
        if others and abs(s_ratio - o_ratio) > DEFAULT_TOLERANCE:
            evidence.append(f"Measured sources imply ratio {o_ratio:.2f}; event status implies {s_ratio:.2f}")
            if s_ratio > o_ratio:
                summary = (
                    f"The event's own status is '{st.status}' (implied ratio {s_ratio:.2f}) while {o_txt} imply little or no loss "
                    f"(ratio about {o_ratio:.2f}). The event may have been called off for a reason the {ctx.noun} reading does not capture "
                    "(artist, permits, safety, ticket sales), so it is worth an audit."
                )
            else:
                summary = (
                    f"{o_txt} imply a loss (ratio about {o_ratio:.2f}) but the event's status is '{st.status}' (implied ratio {s_ratio:.2f}), "
                    "i.e. it appears to be going ahead. It is worth an audit."
                )
            return _guardrail(
                DisputeReport(summary=summary, suspected_cause="event status vs measurement conflict", evidence=evidence,
                              recommendation="escalate", ai_used=False, model="heuristic"),
                ctx,
            )

    # Sources of the same kind (or no cross-domain conflict): decide on the ratio spread alone.
    zeros = [r for r in measured if r.observed_mm == 0]
    nonzero = [r for r in measured if r.observed_mm > 0]
    if zeros and nonzero and ctx.spread > DEFAULT_TOLERANCE:
        zero, other = zeros[0], max(nonzero, key=lambda r: r.observed_mm)
        cause = "sensor dropout"
        summary = (
            f"{zero.source} reports exactly 0 {ctx.unit} while {other.source} reports {other.observed_mm:.1f} {ctx.unit}. "
            f"A flat zero next to a real {ctx.noun} value usually means a data outage or a stuck feed, not a genuine reading. "
            "That zero is worth an audit."
        )
        recommendation = "escalate"
    elif ctx.spread >= HARD_ESCALATE_SPREAD:
        cause = "possible manipulation or fault"
        summary = (
            f"The most-loss source ({most_loss.source}, {_fmt(most_loss)}, ratio {_ratio(p, most_loss):.2f}) and the least-loss source "
            f"({least_loss.source}, {_fmt(least_loss)}, ratio {_ratio(p, least_loss):.2f}) imply payout ratios {ctx.spread:.2f} apart. "
            "That is well beyond normal variance between independent sources and the difference favours a larger payout, "
            "so it is worth an audit."
        )
        recommendation = "escalate"
    else:
        cause = "model spread"
        summary = (
            f"The sources differ ({_fmt(least_loss)} vs {_fmt(most_loss)}, payout ratios {_ratio(p, least_loss):.2f} vs {_ratio(p, most_loss):.2f}) "
            "but stay in the same range; this looks like ordinary variance between providers rather than a fault. "
        )
        recommendation = "auto_resolve"

    return _guardrail(
        DisputeReport(summary=summary, suspected_cause=cause, evidence=evidence,
                      recommendation=recommendation, ai_used=False, model="heuristic"),
        ctx,
    )


async def investigate_with_llm(ctx: DisputeContext) -> DisputeReport:
    """Ask Claude to investigate. Structured JSON output so the shape is
    guaranteed; anything unexpected raises and the caller falls back."""
    import anthropic  # imported lazily so the backend runs without the SDK/key

    client = anthropic.AsyncAnthropic(timeout=60.0, max_retries=1)
    response = await client.messages.create(
        model=WATCHDOG_MODEL,
        max_tokens=4000,
        system=system_prompt(ctx),
        messages=[{"role": "user", "content": ctx.describe() + "\n\nInvestigate and report."}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": REPORT_SCHEMA}},
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("watchdog model refused the request")
    text = next(b.text for b in response.content if b.type == "text")
    data = json.loads(text)
    return _guardrail(
        DisputeReport(
            summary=str(data["summary"]),
            plain=_plain(data.get("plain_summary")),
            suspected_cause=str(data["suspected_cause"]),
            evidence=[str(e) for e in data["evidence"]],
            recommendation=data["recommendation"],
            ai_used=True,
            model=response.model,
        ),
        ctx,
    )


async def investigate_with_groq(ctx: DisputeContext) -> DisputeReport:
    """Same system prompt and same context text as the Claude path; only the network call differs.
    Groq's OpenAI-compatible endpoint (free tier). JSON mode + the schema spelled out in the user
    message, then the same validation and guardrail as every other path."""
    template = {
        "summary": "2-4 plain-language sentences for the reviewer",
        "plain_summary": "2-3 jargon-free sentences for the policyholder, no money amounts",
        "suspected_cause": "short label, e.g. model spread",
        "evidence": ["3-6 concrete points citing the actual numbers"],
        "recommendation": "auto_resolve or escalate",
    }
    schema_hint = (
        "\n\nInvestigate and report. Reply with ONE JSON object and nothing else, using EXACTLY these five keys "
        "(no others, no nesting beyond the evidence array of strings): " + json.dumps(template)
    )
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {_secret('GROQ_API_KEY')}"},
            json={
                "model": _secret("GROQ_MODEL") or GROQ_DEFAULT_MODEL,
                "temperature": 0.2,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": system_prompt(ctx)},
                    {"role": "user", "content": ctx.describe() + schema_hint},
                ],
            },
        )
    resp.raise_for_status()
    body = resp.json()
    data = json.loads(body["choices"][0]["message"]["content"])
    recommendation = data["recommendation"]
    if recommendation not in ("auto_resolve", "escalate"):
        raise ValueError(f"unexpected recommendation {recommendation!r}")
    return _guardrail(
        DisputeReport(
            summary=str(data["summary"]),
            plain=_plain(data.get("plain_summary")),
            suspected_cause=str(data["suspected_cause"]),
            evidence=[str(e) for e in data["evidence"]],
            recommendation=recommendation,
            ai_used=True,
            model=f"groq:{body.get('model', GROQ_DEFAULT_MODEL)}",
        ),
        ctx,
    )


def active_provider() -> str:
    """Which explanation provider `investigate()` will try first (same precedence: Groq, Claude, rule-based). For the startup banner."""
    if _secret("GROQ_API_KEY"):
        return f"Groq ({_secret('GROQ_MODEL') or GROQ_DEFAULT_MODEL})"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return f"Claude ({WATCHDOG_MODEL})"
    return "rule-based (no GROQ_API_KEY / ANTHROPIC_API_KEY)"


async def investigate(policy: Policy, readings: list[SourceReading], floor_ratio: float, ceiling_ratio: float,
                      paid_ratio: float | None = None) -> DisputeReport:
    """Entry point used by main.py. Never raises - the demo must not stall
    because the model is unreachable. Never returns an amount."""
    ctx = DisputeContext(policy, readings, floor_ratio, ceiling_ratio, paid_ratio)
    # Precedence: Groq (free tier) -> Claude -> rule-based. A failing provider falls through to the next.
    providers = []
    if _secret("GROQ_API_KEY"):
        providers.append(("groq", investigate_with_groq))
    if os.environ.get("ANTHROPIC_API_KEY"):
        providers.append(("anthropic", investigate_with_llm))
    if not providers:
        print("[watchdog] no GROQ_API_KEY / ANTHROPIC_API_KEY set - using heuristic investigator")
        return investigate_heuristic(ctx)
    failures = []
    for name, call in providers:
        try:
            return await call(ctx)
        except Exception as e:  # noqa: BLE001 - rate limit, network, refusal, bad JSON...
            print(f"[watchdog] {name} call failed ({e!r})")
            failures.append(f"{name}: {type(e).__name__}")
    report = investigate_heuristic(ctx)
    report.evidence.append(f"AI investigation unavailable ({'; '.join(failures)}); rule-based analysis shown instead.")
    return report


# ---------------------------------------------------------------------------
# Plain-language account of every settlement, shown to the policyholder whether or not the sources agreed.
# ---------------------------------------------------------------------------

def bottom_line(ctx: DisputeContext) -> str:
    """One deterministic sentence with the fact that decides the payout. Shown under every explanation, so the
    key point never depends on the model following instructions."""
    share = "nothing is owed" if ctx.paid <= 0 else "the whole cover is paid" if ctx.paid >= 1 else f"{ctx.paid * 100:.0f}% of the cover is paid"
    mid = ctx.middle_reading()
    return f"The middle report, {mid}, {ctx.paid_position()}, so {share}." if mid else f"The middle result {ctx.paid_position()}, so {share}."


def settlement_fallback(ctx: DisputeContext, disagree: bool) -> str:
    """Rule-based sentences with the same rules as the AI text: everyday words, no money amounts."""
    vals = ", ".join(_fmt(r) for r in ctx.measured) or "the readings"
    share = "nothing is owed" if ctx.paid <= 0 else "the whole cover is paid" if ctx.paid >= 1 else f"{ctx.paid * 100:.0f}% of the cover is paid"
    middle = bottom_line(ctx).replace("The middle report", "The middle one", 1)
    if disagree:
        return f"The sources gave different answers: {vals}. {middle} The app pays by the middle one, so nothing waits and nobody has to approve it."
    return f"The sources reported {vals}. {middle}"


async def explain_settlement(policy: Policy, readings: list[SourceReading], floor_ratio: float, ceiling_ratio: float,
                             paid_ratio: float) -> dict:
    """Ask Groq to tell the policyholder what happened when the sources AGREED (disagreements already get an
    explanation from investigate()). Never raises; never states amounts; falls back to rule-based sentences."""
    ctx = DisputeContext(policy, readings, floor_ratio, ceiling_ratio, paid_ratio)
    fallback = {"plain": settlement_fallback(ctx, disagree=False), "ai_used": False, "model": "rule-based", "bottom_line": bottom_line(ctx)}
    key = _secret("GROQ_API_KEY")
    if not key:
        return fallback
    banned = [w for w in PLAIN_BANNED if w != "NDVI" or ctx.satellite]
    system = ("You explain an automatic parametric insurance payout to the policyholder, someone with no technical, insurance or crypto knowledge. "
              "Write 2-3 short sentences in everyday words, addressing them as \"you\": what the sources reported (numbers with their unit are fine), what the policy's rule is "
              "(where it starts paying and where it pays in full), and what that meant for them: nothing owed, part of the cover, or all of it (a percentage is fine). "
              "Name the middle report with its value and say where it sits against the rule, using the 'In plain words' line of the context (for example: the middle report was X, short of the point where payment starts, so nothing is paid). "
              "Readings marked SIMULATED are demo values chosen on purpose; treat them as real and do not mention it. "
              "Do not mention money amounts or SOL (the app shows them), and never use these words: " + ", ".join(banned) + ". "
              'Reply with ONE JSON object and nothing else: {"plain_summary": "..."}')
    user = ctx.describe() + f"\nShare of the cover paid: {ctx.paid * 100:.0f}%."
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(GROQ_URL, headers={"Authorization": f"Bearer {key}"}, json={
                "model": _secret("GROQ_MODEL") or GROQ_DEFAULT_MODEL, "temperature": 0.2, "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]})
        resp.raise_for_status()
        body = resp.json()
        plain = _plain(json.loads(body["choices"][0]["message"]["content"]).get("plain_summary"))
        if plain:
            return {"plain": plain, "ai_used": True, "model": f"groq:{body.get('model', GROQ_DEFAULT_MODEL)}", "bottom_line": bottom_line(ctx)}
        print("[explain] groq reply broke the plain-language rules; using the rule-based sentences")
    except Exception as e:  # noqa: BLE001 - network, rate limit, bad JSON
        print(f"[explain] groq call failed ({e!r})")
    return fallback
