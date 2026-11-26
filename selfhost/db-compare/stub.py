"""The one model all three chat apps talk to in the database comparison (run.sh).

An OpenAI-compatible endpoint that lists one model and answers every chat request, title and tag
requests included, with one fixed sentence carrying the answer canary. Every app's own background
calls therefore write the same canary wherever they store a model's words, and no prompt leaves
this machine. Streams or not, as asked. Standard library only.
"""

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "compare-stub"
ANSWER = os.environ.get("STUB_ANSWER", "The stub answers: ANSWER-KESTREL-9302.")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"stub {self.command} {self.path}", flush=True)

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path in ("/v1/models", "/models"):
            self.send_json(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "stub"}]})
        elif path in ("", "/health"):
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": f"stub does not serve GET {self.path}"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if self.path.split("?")[0].rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            self.send_json(404, {"error": f"stub does not serve POST {self.path}"})
            return
        created = int(time.time())
        usage = {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}
        if not body.get("stream"):
            self.send_json(200, {
                "id": "stub-1", "object": "chat.completion", "created": created, "model": MODEL,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": ANSWER}, "finish_reason": "stop"}],
                "usage": usage,
            })
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        chunks = [({"role": "assistant", "content": ANSWER}, None), ({}, "stop")]
        for delta, finish in chunks:
            chunk = {
                "id": "stub-1", "object": "chat.completion.chunk", "created": created, "model": MODEL,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            if finish:
                chunk["usage"] = usage
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
