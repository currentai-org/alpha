"""Run the agent service under uvicorn, draining running tasks before a stop (CUR-4598).

`uvicorn app:app` closes its listening socket on the first SIGTERM or SIGINT, and Fly stops the machine
kill_timeout seconds later, so a deploy would kill every task mid-run. Here the first stop signal starts
app.begin_drain instead: new /run calls get a 503 with Retry-After while running tasks keep their event
streams, downloads and confirms, and uvicorn's own graceful exit starts once they finish (or the drain's
deadline passes). A second signal, which Fly sends when kill_timeout runs out, cuts the wait short.

    python serve.py                 # what the image runs; AGENT_HOST / AGENT_PORT override the bind
"""

import os
from types import FrameType

import app
import uvicorn

HOST = os.environ.get("AGENT_HOST", "0.0.0.0")
PORT = int(os.environ.get("AGENT_PORT", "8731"))
# Seconds uvicorn waits for open connections after the drain hands over: the interrupted tasks' streams
# have their `done` frames by then, so this only bounds a client that never reads to the end.
GRACEFUL_SECS = int(os.environ.get("AGENT_GRACEFUL_SHUTDOWN_SECS", "10"))


class DrainingServer(uvicorn.Server):
    def handle_exit(self, sig: int, frame: FrameType | None) -> None:
        if self.should_exit:                       # already exiting: uvicorn's own second-signal handling
            super().handle_exit(sig, frame)
            return
        if not app.begin_drain(lambda: uvicorn.Server.handle_exit(self, sig, frame)):
            app.end_drain_now()                    # a second signal mid-drain: stop waiting


def server(host: str = HOST, port: int = PORT) -> DrainingServer:
    return DrainingServer(uvicorn.Config(app.app, host=host, port=port, timeout_graceful_shutdown=GRACEFUL_SECS))


if __name__ == "__main__":
    server().run()
