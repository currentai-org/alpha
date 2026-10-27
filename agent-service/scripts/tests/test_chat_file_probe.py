"""The chat file probe's verdict rules, on status dicts shaped like develop's real CUR-4595 failures."""
import io
import sys
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import chat_file_probe as cfp

DOCX = {"name": "heating_repair_request.docx", "bytes": 36786, "text": None, "truncated": True}


def test_a_delivered_docx_with_a_plain_answer_passes():
    assert cfp.judge({"state": "COMPLETED", "result": "I saved the letter.", "artifacts": [DOCX]}, ".docx") == []


def test_develops_false_failure_fails_on_both_the_give_up_text_and_the_missing_claim():
    st = {"state": "COMPLETED", "artifacts": [DOCX],
          "result": "I was not able to complete this after several attempts. I don't have a verified result.",
          "unrun_detail": "wrote-and-never-ran:claimed-file-missing:heating_repair_request.docx"}
    why = cfp.judge(st, ".docx")
    assert len(why) == 2 and "give-up" in why[0] and "caveat" in why[1]


def test_no_file_of_the_asked_type_fails_even_when_the_answer_sounds_done():
    st = {"state": "COMPLETED", "result": "Done.", "artifacts": [{"name": "letter.md", "bytes": 900}]}
    assert cfp.judge(st, ".docx") == ["no non-empty .docx delivered (artifacts: ['letter.md'])"]


def test_an_empty_file_does_not_count_as_delivered():
    st = {"state": "COMPLETED", "result": "Done.", "artifacts": [{**DOCX, "bytes": 0}]}
    assert cfp.judge(st, ".docx")


def test_a_failed_task_fails():
    assert cfp.judge({"state": "FAILED", "error": "sandbox", "artifacts": [DOCX]}, ".docx")


def test_any_unrun_detail_fails_because_the_site_shows_a_caveat_for_every_value():
    st = {"state": "COMPLETED", "result": "Here is your letter.",
          "artifacts": [{"name": "letter.docx", "bytes": 9000}], "unrun_detail": "structural:anything at all"}
    assert any("caveat" in w for w in cfp.judge(st, ".docx"))


BROKEN_XLSX = (Path(__file__).resolve().parents[2] / "api" / "testdata" / "header_in_values_chart.xlsx").read_bytes()


def test_a_delivered_workbook_whose_chart_plots_the_header_fails_the_chart_judge():
    why = cfp.judge_charts({"neighbourhood_comparison.xlsx": BROKEN_XLSX})
    assert len(why) == 1 and "B1:B5" in why[0]


def test_a_workbook_with_no_chart_fails_the_chart_judge_because_the_prompt_asked_for_one():
    buf = io.BytesIO()
    openpyxl.Workbook().save(buf)
    assert cfp.judge_charts({"plain.xlsx": buf.getvalue()}) == ["no chart in the delivered workbook"]


def test_a_workbook_that_could_not_be_downloaded_fails_the_chart_judge():
    assert cfp.judge_charts({"gone.xlsx": None}) == ["gone.xlsx could not be downloaded"]
