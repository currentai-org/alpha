#!/usr/bin/env bash
# Smoke for deploy.yml: /chat/healthcheck and / answer 200 (six tries, ten seconds apart), and / carries the
# chat composer's data-testid, so a page that loads without the chat surface fails too.
#   BASE=<url> .github/scripts/deploy-smoke.sh
set -u
base=${BASE:?BASE is the URL to smoke}
base=${base%/}
code() { curl -sS -o /dev/null -w '%{http_code}' -L "$1" || echo 000; }
for attempt in 1 2 3 4 5 6; do
	health=$(code "$base/chat/healthcheck")
	root=$(code "$base/")
	echo "attempt $attempt: healthcheck=$health root=$root"
	if [ "$health" = 200 ] && [ "$root" = 200 ]; then
		if curl -sS -L "$base/" | grep -q 'data-testid="chat-scroll"'; then
			echo "smoke ok on $base"
			exit 0
		fi
		echo "::error title=deploy smoke::$base/ is 200 but has no chat-scroll marker: the chat surface is not at the root"
		exit 1
	fi
	sleep 10
done
echo "::error title=deploy smoke::$base failed (healthcheck=$health root=$root)"
exit 1
