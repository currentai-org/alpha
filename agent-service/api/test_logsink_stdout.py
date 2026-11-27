"""The stdout log is one JSON record per line, however many threads write to it at once."""
import json
import sys
import threading
import time

import logsink


class _SlowStream:
    """A stdout stand-in that yields inside every write, so two threads' writes interleave as they
    can on a busy host. A record written as two writes (text, then newline) splits under it."""

    def __init__(self):
        self.parts: list[str] = []
        self._lock = threading.Lock()

    def write(self, s: str) -> int:
        time.sleep(0.0005)
        with self._lock:
            self.parts.append(s)
        return len(s)

    def flush(self) -> None:
        pass


def test_concurrent_records_each_land_on_their_own_line(monkeypatch):
    stream = _SlowStream()
    monkeypatch.setattr(sys, "stdout", stream)
    threads, per = 8, 40

    def writer(n: int) -> None:
        for i in range(per):
            logsink.stdout_line({"event": "t", "thread": n, "i": i, "pad": "x" * 60})

    pool = [threading.Thread(target=writer, args=(n,)) for n in range(threads)]
    for t in pool:
        t.start()
    for t in pool:
        t.join()

    lines = "".join(stream.parts).splitlines()
    records = [json.loads(ln) for ln in lines]  # a merged line raises "Extra data" here
    assert len(records) == threads * per, f"{len(lines)} lines for {threads * per} records"
    assert {(r["thread"], r["i"]) for r in records} == {(n, i) for n in range(threads) for i in range(per)}
