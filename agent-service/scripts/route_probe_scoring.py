"""Pure scoring for `route_probe.py` — no network I/O, so it can be unit-tested and mutation-tested
in isolation from the HTTP-calling script.

A single overall accuracy number hides a router that says DIRECT to everything: with more direct
than agentic cases in the set, that failure mode still scores well above 50%. Scoring per category
is what makes a systematic miss (a whole class of prompt, not one example) visible and failable.
"""
from __future__ import annotations

from dataclasses import dataclass

CATEGORY_THRESHOLD = 0.75


@dataclass(frozen=True)
class Case:
    prompt: str
    agentic: bool
    category: str


@dataclass(frozen=True)
class CategoryScore:
    category: str
    correct: int
    total: int

    @property
    def accuracy(self) -> float:
        return self.correct / self.total if self.total else 1.0

    @property
    def ok(self) -> bool:
        return self.accuracy >= CATEGORY_THRESHOLD


def case_ok(want: bool, got: bool, source: str) -> bool:
    """Whether one routed case counts as correct. A `fallback` verdict is the router failing (gateway down,
    timeout, unparseable reply) and defaulting to DIRECT; it is a miss even where DIRECT was the label,
    or a dead router scores 100% on every direct category (CUR-2154)."""
    return source != "fallback" and got == want


def is_moderation_block(status: int, body: str) -> bool:
    """Whether a /route error is the agent service's input screen refusing the probe's own prompt. Such a
    case never reached the router, so it is neither a hit nor a miss; the run reports it on its own
    rather than stopping at the first one (CUR-2154)."""
    return status == 403 and "blocked by moderation" in body


def score_by_category(rows: list[dict]) -> dict[str, CategoryScore]:
    """`rows`: dicts carrying at least `category` (str) and `ok` (bool, whether the router's answer
    matched the label). Returns one CategoryScore per category seen, in first-seen order."""
    scored: dict[str, CategoryScore] = {}
    for row in rows:
        cat = row["category"]
        prev = scored.get(cat, CategoryScore(cat, 0, 0))
        scored[cat] = CategoryScore(cat, prev.correct + (1 if row["ok"] else 0), prev.total + 1)
    return scored


def all_categories_ok(scored: dict[str, CategoryScore]) -> bool:
    return all(s.ok for s in scored.values())
