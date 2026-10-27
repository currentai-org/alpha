"""Real pytest coverage for route_probe_scoring.py, written to give mutmut (CUR-1189) something to
kill — logic mutations (inverted conditionals, wrong comparisons, dropped guards) that this module's
own type checker can't see. Pins the exact CATEGORY_THRESHOLD boundary, since that's where a `>=`->`>`
or `>=`->`<` mutation would otherwise survive silently.
"""
import sys
from pathlib import Path

# Package-qualified import (not a bare `from route_probe_scoring import ...`) is load-bearing for
# mutmut: it mutates scripts/route_probe_scoring.py as package member `scripts.route_probe_scoring`,
# and only sees a test's coverage of a mutant if the test imports it the same way — a bare import
# resolves fine under plain pytest but silently fails mutmut's own trampoline-hit matching.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from scripts.route_probe_scoring import (
    CATEGORY_THRESHOLD,
    CategoryScore,
    all_categories_ok,
    case_ok,
    is_moderation_block,
    score_by_category,
)


def _rows(category: str, oks: list[bool]) -> list[dict]:
    return [{"category": category, "ok": ok} for ok in oks]


def test_score_by_category_counts_correct_and_total_per_category():
    rows = _rows("agentic", [True, True, False]) + _rows("direct", [True])
    scored = score_by_category(rows)
    assert scored["agentic"].category == "agentic"
    assert scored["agentic"].correct == 2
    assert scored["agentic"].total == 3
    assert scored["direct"].category == "direct"
    assert scored["direct"].correct == 1
    assert scored["direct"].total == 1


def test_score_by_category_preserves_first_seen_order():
    rows = _rows("z-cat", [True]) + _rows("a-cat", [True])
    assert list(score_by_category(rows).keys()) == ["z-cat", "a-cat"]


def test_accuracy_is_correct_over_total():
    s = CategoryScore("x", correct=3, total=4)
    assert s.accuracy == 0.75


def test_accuracy_on_empty_category_is_1_not_0():
    # An unseen/empty category must not read as a failing 0% — score_by_category never emits one
    # (every row it counts sets total>=1), but the dataclass's own default must stay non-punitive.
    s = CategoryScore("x", correct=0, total=0)
    assert s.accuracy == 1.0


def test_ok_is_true_exactly_at_the_threshold_boundary():
    # 3/4 == CATEGORY_THRESHOLD exactly. This is the case that kills a `>=` -> `>` mutation: only
    # `>=` returns True here, `>` returns False.
    assert CATEGORY_THRESHOLD == 0.75
    s = CategoryScore("x", correct=3, total=4)
    assert s.accuracy == CATEGORY_THRESHOLD
    assert s.ok is True


def test_ok_is_false_just_below_the_threshold():
    # 11/15 ~= 0.733, clearly under 0.75 without being a suspicious round number — kills a `>=` -> `<`
    # mutation (which would wrongly return True here) as well as a dropped-guard `ok` that always
    # returns True.
    s = CategoryScore("x", correct=11, total=15)
    assert s.accuracy < CATEGORY_THRESHOLD
    assert s.ok is False


def test_all_categories_ok_requires_every_category_to_pass():
    scored = {
        "agentic": CategoryScore("agentic", correct=4, total=4),
        "direct": CategoryScore("direct", correct=1, total=4),
    }
    assert all_categories_ok(scored) is False


def test_all_categories_ok_true_when_every_category_passes():
    scored = {
        "agentic": CategoryScore("agentic", correct=4, total=4),
        "direct": CategoryScore("direct", correct=3, total=4),
    }
    assert all_categories_ok(scored) is True


def test_all_categories_ok_vacuously_true_on_empty_input():
    # Mirrors Python's own all([]) == True — a probe run with zero categories must not read as a
    # failure (that would make an empty/misconfigured run look like it failed for the wrong reason).
    assert all_categories_ok({}) is True


def test_case_ok_counts_a_fallback_as_a_miss_even_where_direct_was_the_label():
    """CUR-2154: a router timeout falls back to DIRECT, and a timeout must not score ok on a direct case."""
    assert case_ok(want=False, got=False, source="fallback") is False
    assert case_ok(want=True, got=False, source="fallback") is False


def test_case_ok_is_a_label_match_for_real_verdicts():
    for src in ("model", "memo"):
        assert case_ok(want=True, got=True, source=src) is True
        assert case_ok(want=False, got=False, source=src) is True
        assert case_ok(want=True, got=False, source=src) is False
        assert case_ok(want=False, got=True, source=src) is False


# The input screen refusing a probe prompt is reported as its own outcome, not as a router miss
# and not as a crash of the run. (CUR-2154)
BLOCK_BODY = '{"detail":"blocked by moderation (input): block:chat-block-fraud"}'


def test_a_403_from_input_moderation_is_a_moderation_block():
    assert is_moderation_block(403, BLOCK_BODY)


def test_a_403_for_any_other_reason_is_not_a_moderation_block():
    assert not is_moderation_block(403, '{"detail":"forbidden"}')


def test_a_moderation_body_on_another_status_is_not_a_moderation_block():
    assert not is_moderation_block(401, BLOCK_BODY)
    assert not is_moderation_block(500, BLOCK_BODY)
