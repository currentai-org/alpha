#!/usr/bin/env python3
"""Tiny client for the Public AI agent service — the thing you hand a testing user.

Submits a prompt to the deployed /run API, polls to completion, and prints the result plus the
service's own deterministic `verified` verdict. Pure Python stdlib — no pip installs, runs on any
python3. The tester needs only this file, the service URL, and their bearer token.

Usage:
  export AGENT_URL=https://<your-app>.fly.dev
  export AGENT_TOKEN=<the bearer token you were given>
  python client.py "Using the terminal tool only: create a.py and b.py, count the .py files, write the number to out.txt"

  # optional: have the service deterministically confirm a side effect
  python client.py "...write the count to out.txt..." --expect-file out.txt --expect-contains 2
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request


def _req(method, url, token, body=None, machine_id=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"authorization": f"Bearer {token}", "x-agent-account": "user", "content-type": "application/json"}
    if machine_id:
        # Pin follow-up requests to the machine that created the task — a multi-machine
        # deploy has no session affinity by default, so an unpinned poll can land on a machine that
        # never saw it and 404. (CUR-895)
        headers["Fly-Force-Instance-Id"] = machine_id
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as e:
        return e.code, {"error": (e.read() or b"").decode("utf-8", "ignore")[:300]}
    except urllib.error.URLError as e:
        return 0, {"error": f"could not reach {url}: {e.reason}"}


def main():
    ap = argparse.ArgumentParser(description="Run one task against the Public AI agent service.")
    ap.add_argument("prompt", help="what you want the agent to do")
    ap.add_argument("--url", default=os.environ.get("AGENT_URL", ""), help="service URL (or AGENT_URL env)")
    ap.add_argument("--token", default=os.environ.get("AGENT_TOKEN", ""), help="bearer token (or AGENT_TOKEN env)")
    ap.add_argument("--expect-file", default=None, help="verify: a file the task should create")
    ap.add_argument("--expect-contains", default=None, help="verify: substring that file must contain")
    ap.add_argument("--timeout", type=int, default=240, help="seconds to wait for completion")
    args = ap.parse_args()
    if not args.url or not args.token:
        sys.exit("set AGENT_URL and AGENT_TOKEN (or pass --url/--token)")
    url = args.url.rstrip("/")

    body = {"prompt": args.prompt}
    if args.expect_file:
        body["verify"] = {"expect_file": args.expect_file}
        if args.expect_contains is not None:
            body["verify"]["expect_contains"] = args.expect_contains

    st, out = _req("POST", f"{url}/run", args.token, body)
    if st == 401:
        sys.exit("401 — bad or expired token (ask for a fresh one)")
    if st != 200:
        sys.exit(f"POST /run failed [{st}]: {out.get('error') or out}")
    rid = out.get("id")
    if not rid:
        sys.exit(f"no run id in response: {out}")
    mid = out.get("machine_id")

    print(f"run {rid} submitted — working (up to {args.timeout}s)…", flush=True)
    out = {}
    for _ in range(max(1, args.timeout // 3)):
        st, out = _req("GET", f"{url}/run/{rid}", args.token, machine_id=mid)
        if st != 200:
            sys.exit(f"GET /run/{rid} failed [{st}]: {out.get('error') or out}")
        if str(out.get("state", "")).upper() in ("COMPLETED", "FAILED", "CANCELED"):
            break
        print("·", end="", flush=True)
        time.sleep(3)
    print()

    state = str(out.get("state", "")).upper()
    verified = out.get("verified")
    mark = "✅ VERIFIED" if verified else ("✅ done" if state == "COMPLETED" else f"❌ {state or 'no result'}")
    print(f"  {mark}   (calls={out.get('model_calls', 0)}, tokens={out.get('tokens', 0)})")
    if out.get("summary"):
        print(f"  summary: {out['summary']}")
    if out.get("error"):
        print(f"  error  : {out['error']}")
    if out.get("result"):
        print(f"  output : {out['result']}")
    sys.exit(0 if (verified or state == "COMPLETED") else 1)


if __name__ == "__main__":
    main()
