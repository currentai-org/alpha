"""Open WebUI's SQLite: every table.column holding either canary, with how many rows hold each.

Runs inside the open-webui container (run.sh pipes it in): python - <db path> <user canary> <answer canary>.
Prints one tab-separated line per hit: table.column, rows with the user canary, rows with the answer canary.
"""

import sqlite3
import sys

db, user, answer = sys.argv[1:4]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
for table in tables:
    cols = [r[1] for r in con.execute(f'pragma table_info("{table}")')]
    for col in cols:
        counts = []
        for canary in (user, answer):
            n = con.execute(
                f'select count(*) from "{table}" where cast("{col}" as text) like ?', (f"%{canary}%",)
            ).fetchone()[0]
            counts.append(n)
        if any(counts):
            print(f"{table}.{col}\t{counts[0]}\t{counts[1]}")
