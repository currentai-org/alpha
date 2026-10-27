"""Live probe for the no-tool review (CUR-4599): replies with known verdicts, sent to a real model with the exact
body app.py sends (no_tool_review.review_body). Prints PASS/FAIL per case and exits non-zero below --min.

Run from web/ so Doppler supplies the router key:
    doppler run --config preview -- python3 -I ../agent-service/scripts/no_tool_review_probe.py ../agent-service/api -k 3
PROBE_MODEL picks the model (default: the router name for Mistral Medium, which the agent uses). The
requests and replies are our own fixtures.
"""
import argparse
import json
import os
import sys
import urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("api_dir")
ap.add_argument("-k", type=int, default=1, help="runs per case")
args = ap.parse_args()
sys.path.insert(0, args.api_dir)
import no_tool_review  # noqa: E402 — the real prompt, tool and parser, not a copy

ACCEPT, RETRY = "accept", "retry"
# (want, request, reply). `want` is the outcome, since declined/answered both accept and skipped/narrated
# both retry; the verdict is printed beside it.
cases = [
    # An honest refusal, as an agent answers it (CUR-4599).
    (ACCEPT, "Great, now email the letter to my landlord at landlord@example.com and let me know when it's sent.",
     "I cannot send emails. You will need to attach heating_repair_request.docx and send it yourself to landlord@example.com."),
    (ACCEPT, "Book me a table for two at Dishoom tonight.",
     "I can't make bookings or contact restaurants. You can book through Dishoom's website or by phone."),
    (ACCEPT, "Post this summary to my team's Slack channel.",
     "I don't have access to Slack or any messaging service, so I can't post it. You can copy the summary above and paste it into the channel."),
    (ACCEPT, "Pay my electricity bill with the card on file.",
     "I can't make payments or use cards. Please pay through your provider's website or app."),
    (ACCEPT, "What's the difference between a .docx and a .doc file?",
     "A .doc is the older binary Word format; .docx, introduced in Word 2007, is a zipped set of XML files."),
    (ACCEPT, "Thanks, that's perfect!", "You're welcome. Good luck with the landlord."),
    # A follow-up that claims a run the agent never made (CUR-574).
    (RETRY, "Actually run the script now and tell me the totals.",
     "I ran the script. The totals are: North 41,200, South 38,950, East 27,310."),
    (RETRY, "Write a short letter to my landlord and save it as a Word document.",
     "I've saved the letter as landlord_letter.docx in your files."),
    (RETRY, "Add a column for green space to the spreadsheet.",
     "Done. I added a Green space column to neighbourhoods.xlsx and filled it in for all four areas."),
    # CUR-766's shape: hands over work its tools could have done.
    (RETRY, "Make me a CSV of 20 rows of fake sales data.",
     "Here is a Python script that generates the CSV. Save it as make_csv.py and run `python make_csv.py`:\n\n```python\nimport csv, random\n...\n```"),
    (RETRY, "Make an Excel spreadsheet comparing rent in four neighbourhoods, with a bar chart.",
     "You can do this in Excel: put the neighbourhoods in column A and the rents in column B, then select both columns and choose Insert > Bar chart."),
    (RETRY, "Make me a Word document with a one-page note about the class trip.",
     "I'll create the Word document now with the trip details."),
    # A refusal of one part beside a claim of the other part done is narrated.
    (RETRY, "Write the letter as a Word file and email it to my landlord.",
     "I wrote the letter and saved it as letter.docx. I can't send email, so please attach it and send it yourself."),
]
ok = n = 0
model = os.environ.get("PROBE_MODEL", "mistralai/mistral-medium-3-5")
base = (os.environ.get("MISTRAL_CHAT_BASE_URL") or os.environ["MISTRAL_BASE_URL"]).rstrip("/")
key = os.environ.get("MISTRAL_CHAT_API_KEY") or os.environ["MISTRAL_API_KEY"]
for want, request, reply in cases:
    for _ in range(args.k):
        n += 1
        body = {"model": model, **no_tool_review.review_body(request, reply, 200)}
        req = urllib.request.Request(base + "/chat/completions", data=json.dumps(body).encode(),
                                     headers={"authorization": f"Bearer {key}", "content-type": "application/json",
                                              "user-agent": "aipotluck-no-tool-probe/1"})
        try:
            r = json.load(urllib.request.urlopen(req, timeout=60))
            ch = r["choices"][0]
            verdict = no_tool_review.parse_verdict(ch["message"])
            got = ACCEPT if verdict in no_tool_review.ACCEPTED else RETRY
            ok += got == want
            print("PASS" if got == want else "FAIL", want, verdict, ch.get("finish_reason"), "|", reply[:70])
        except Exception as e:  # noqa: BLE001 — a probe reports every failure as a row and keeps going
            print("ERR", want, type(e).__name__, (e.read()[:300] if hasattr(e, "read") else str(e)[:200]))
print(f"{ok}/{n}")
sys.exit(0 if ok == n else 1)
