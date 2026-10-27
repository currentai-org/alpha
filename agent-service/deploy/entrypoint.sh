#!/bin/sh
# Default-deny egress, then drop to the unprivileged app user (CUR-207).
#
# WHY THIS FILE EXISTS. The agent's toolset carries `terminal` and `code_execution`, and the bwrap profile
# (api/app.py) unshares pid/ipc/uts but NOT net — its comment defers network policy to the orchestrator, which is not present on a single machine. Without this file, a
# process inside the sandbox reaches https://example.com and gets a 200. aipotluck.org is open signup, so
# that is an open HTTP proxy with a web form in front of it, billed to us and attributed to our egress IP.
#
# The control is a destination allowlist rather than a per-process one because the service's own outbound
# needs are tiny and stable — the model gateway over 6PN, and the Axiom log sink — so the agent and the app
# can share one allowlist without the agent gaining anything. Filtering per-uid or per-cgroup would let the
# app keep wider reach, at the cost of a uid split and a cgroup delegation this does not need.
#
# TWO ALLOWLISTS, ONE LIST. The connect filter (nftables, below) says which ADDRESSES may be dialled. The
# name filter (AGENT_DNS, below) says which NAMES may be turned into addresses. They are generated from the
# same resolution pass on purpose: a name the service can resolve but not connect to is a dead end, and a
# name it can connect to but not resolve is a dead end too. Keeping one table behind both is what stops
# them drifting apart.
#
# ROOT IS ONLY FOR THIS SCRIPT. Installing packet filters needs NET_ADMIN; running the agent as root would
# break bwrap, which uses the unprivileged user-namespace path in a container (see deploy/Dockerfile). So
# the rules go in as root and the last line drops to $RUN_UID before anything else starts. Root staying
# behind matters twice over now: RLIMIT_NPROC does not apply to uid 0, and the DNS exemption below is
# written in terms of uid 0, so both controls are only real because the app is not root.
set -eu

RUN_UID="${AGENT_RUN_UID:-10001}"
EGRESS="${AGENT_EGRESS:-off}"                      # off | allowlist
REQUIRED="${AGENT_EGRESS_REQUIRED:-0}"             # 1 = refuse to start if the rules can't be installed
DNS="${AGENT_DNS:-off}"                            # off | hosts  (hosts = block :53, serve names from /etc/hosts)
DNS_REQUIRED="${AGENT_DNS_REQUIRED:-0}"            # 1 = refuse to start if the name filter can't be installed
DNS_REFRESH="${AGENT_DNS_REFRESH:-60}"             # seconds between re-resolutions
DNS_CACHE="${AGENT_DNS_CACHE:-/run/agent-dns.tsv}"  # "addr<TAB>name", the one table behind both allowlists
# Overridable ONLY so the block-rewrite logic can be tested without root and without a container — the
# marker handling, the carry-forward, and the atomic rename are the parts most likely to be wrong and the
# least likely to be noticed, since a bad rewrite of /etc/hosts fails as "the gateway went away".
HOSTS_FILE="${AGENT_HOSTS_FILE:-/etc/hosts}"
DNS_MARK_A='#agent-dns-begin'
DNS_MARK_B='#agent-dns-end'
# Public hostnames the SERVICE needs, resolved once at boot into an nft set. The model gateway is NOT
# listed here — it isn't a public hostname, and allow_addrs() below pins its 6PN address separately
# (CUR-1179), fed by the same resolve_all()/managed_names() pass as everything else in this file.
#
# huggingface.co IS DELIBERATELY ABSENT. The agent's HF client fetches tokenizer and config metadata from
# the hub even though HF_BASE_URL redirects model calls to our gateway. What matters is this chain's
# refusal MODE, not this list's contents: a dropped SYN costs the caller a full TCP retry ladder (a turn
# takes several times longer) and the `reject` ending the chain returns immediately. The hub's
# addresses are rotating Cloudflare edge addresses shared with a large slice of the web, and boot-time
# resolution disagrees with what the agent actually dials, so pinning them would be unreliable as well as
# wider. The tokenizer fetch is refused at no measurable cost. Do not re-add it to fix a slow turn; check
# the refusal mode first.
#
# AND THIS DEFAULT MUST NEVER BE WIDER THAN WHAT WE DEPLOY. Every surface sets AGENT_EGRESS_ALLOW_HOSTS
# explicitly, so nothing reaches this fallback, and an unreachable default can drift unnoticed. It is not
# harmless: it is what the NEXT surface inherits, and it would hand that surface more egress than anything
# we currently run, silently. Pinned by test_the_fallback_allowlist_is_never_wider_than_what_ships.
ALLOW_HOSTS="${AGENT_EGRESS_ALLOW_HOSTS:-api.axiom.co}"

fail() {
    echo "{\"event\":\"egress.failed\",\"reason\":\"$1\"}" >&2
    # Fail CLOSED by default when the operator asked for filtering. A container that silently starts with
    # open egress after being told to filter is the exact shape of failure this whole change is about:
    # the config says protected, the machine is not, and nothing reports the difference.
    [ "$REQUIRED" = "1" ] && exit 1
    echo '{"event":"egress.degraded","note":"continuing UNFILTERED — set AGENT_EGRESS_REQUIRED=1 to refuse"}' >&2
    return 0
}

dns_fail() {
    echo "{\"event\":\"dns.failed\",\"reason\":\"$1\"}" >&2
    [ "$DNS_REQUIRED" = "1" ] && exit 1
    echo '{"event":"dns.degraded","note":"name resolution left OPEN — set AGENT_DNS_REQUIRED=1 to refuse"}' >&2
    DNS=off      # do not install the :53 block on top of a hosts file we could not write
    return 0
}

# ---------------------------------------------------------------------------- name table
# scheme://user@host:port/path -> host (also unwraps a [v6] literal), so the hostnames the service dials
# are DERIVED from the URLs it dials rather than repeated in a second env var that can drift out of step.
url_host() {
    printf '%s\n' "$1" | sed -e 's|^[A-Za-z][A-Za-z0-9+.-]*://||' -e 's|/.*$||' -e 's|^.*@||' \
                             -e 's|:[0-9]*$||' -e 's|^\[||' -e 's|\]$||'
}

# Hosts of the MCP servers agent mode is configured to call (CUR-3025), from AGENT_MCP_SERVERS, through the
# same parser the app validates it with (api/mcp_config.py), so a server the app refuses never gets an
# egress hole and one it accepts is never left without one. Unset prints nothing. A config error prints
# nothing on stdout and says why on stderr; it never fails the boot, since `|| true` keeps `set -e` out of it.
MCP_CONFIG_PY="${AGENT_MCP_CONFIG_PY:-/srv/api/mcp_config.py}"
mcp_hosts() {
    [ -n "${AGENT_MCP_SERVERS:-}" ] || return 0
    python3 "$MCP_CONFIG_PY" hosts || true
}

# Names in the CONNECT allowlist — these get nft set entries.
allow_names() { { printf '%s\n' "$ALLOW_HOSTS" | tr ',' '\n'; mcp_hosts; } | sed '/^[[:space:]]*$/d' | sort -u; }

# Internal hosts the service dials by URL and pins by address, the way the gateway is: never names in the
# public allowlist. The E2B link (CUR-4482) joins only when a deploy selects that backend, so a bwrap deploy
# gains no reach into another app on the org's private network.
pinned_hosts() {
    [ -n "${AGENT_MODEL_PROXY_URL:-}" ] && url_host "$AGENT_MODEL_PROXY_URL"
    if [ "${AGENT_SANDBOX_BACKEND:-e2b}" = "e2b" ]; then
        for u in "${E2B_API_URL:-}" "${E2B_SANDBOX_URL:-}"; do [ -n "$u" ] && url_host "$u"; done
    fi
    return 0
}

# Every name the service resolves. The model gateway rides this same resolution pass — allow_addrs()
# below pulls its address out of the same $DNS_CACHE this function fills (CUR-1179) — so its hosts
# entry and its nft pin come from one pass, never two that could disagree.
# COOP_URL is different: it's coop.publicai.co, a real external host, so unlike the gateway it also
# needs an actual entry in ALLOW_HOSTS (the CONNECT allowlist), not just here. This loop only makes a
# name resolvable; it does not by itself make it reachable.
managed_names() {
    { allow_names
      pinned_hosts
      [ -n "${COOP_URL:-}" ] && url_host "$COOP_URL"
      printf '%s\n' "${AGENT_DNS_EXTRA_HOSTS:-}" | tr ',' '\n'
    } | sed '/^[[:space:]]*$/d' | sort -u
}

# Never fails, even on the first boot when the cache does not exist yet. This matters more than it looks:
# the script runs under `set -e`, and an awk exiting 2 on a missing file at the tail of an && list would
# abort the container before the app ever starts.
addrs_of() {
    [ -f "$1" ] || return 0
    awk -F'\t' -v h="$2" '$2 == h { print $1 }' "$1" 2>/dev/null || true
}

# The addresses behind the CONNECT allowlist, deduped — the nft sets' contents. The model gateway
# joins this set too (CUR-1179), pinned by address instead of a wholesale accept on all of Fly's 6PN
# range: resolve_all() refreshes the gateway's address on the same DNS_REFRESH timer as every
# public host below.
allow_addrs() {
    { for h in $(allow_names); do addrs_of "$DNS_CACHE" "$h"; done
      for h in $(pinned_hosts); do addrs_of "$DNS_CACHE" "$h"; done
    } | sort -u
}

resolve_all() {
    # Refresh $DNS_CACHE. `getent ahosts` covers both families and is in the base image.
    tmp="$DNS_CACHE.$$"
    # `true`, not `:`. A redirection failure on a SPECIAL builtin makes a non-interactive POSIX shell exit
    # outright, so `: > "$tmp"` on an unwritable directory would kill the container with a bare "Permission
    # denied" instead of taking the degrade path three lines down. And stderr is redirected BEFORE the
    # output redirect, so the shell's own complaint about the failing one is caught too.
    true 2>/dev/null > "$tmp" || return 1
    for h in $(managed_names); do
        # `-s dns` and not a bare `getent ahosts`, which would make this loop pointless. nsswitch is
        # `files dns`, so once the managed block exists a plain lookup answers out of the file this
        # function WROTE — the refresh would re-read its own output forever and every address would be
        # pinned at whatever it was during boot, which is precisely the staleness the loop exists to stop.
        # Falls back to the ordinary path if a glibc ever refuses the flag: same-as-before beats nothing.
        got="$(getent -s dns ahosts "$h" 2>/dev/null | awk '{print $1}' | sort -u)"
        [ -z "$got" ] && got="$(getent ahosts "$h" 2>/dev/null | awk '{print $1}' | sort -u)"
        # CARRY FORWARD on failure, never delete. This table feeds both /etc/hosts and the connect filter,
        # so a name dropping out on one flaky lookup would take the gateway or the log sink down until the
        # next refresh, which is worse than a stale address. A CDN that genuinely moves is picked up on the next successful pass.
        [ -z "$got" ] && got="$(addrs_of "$DNS_CACHE" "$h")"
        for a in $got; do printf '%s\t%s\n' "$a" "$h" >> "$tmp"; done
    done
    mv "$tmp" "$DNS_CACHE"
}

HOSTS_WRITE=untried    # rename | in-place — recorded because the two have different atomicity

apply_hosts() {
    [ -s "$DNS_CACHE" ] || return 1
    tmp="$HOSTS_FILE.agent-dns.$$"
    # Replace the whole managed block; everything outside the markers is left exactly as the platform
    # wrote it (fly-local-6pn, fly-global-services, localhost).
    { sed "/^$DNS_MARK_A\$/,/^$DNS_MARK_B\$/d" "$HOSTS_FILE"
      echo "$DNS_MARK_A"
      awk -F'\t' '{ print $1 "\t" $2 }' "$DNS_CACHE"
      echo "$DNS_MARK_B"
    } > "$tmp" 2>/dev/null || { rm -f "$tmp"; return 1; }

    # Nothing changed — the overwhelmingly common case on a refresh tick. Skipping the write is not an
    # optimisation, it is what keeps the in-place path below almost never used.
    if cmp -s "$tmp" "$HOSTS_FILE"; then rm -f "$tmp"; return 0; fi

    # Prefer the atomic rename: a getaddrinfo racing it sees the old file or the new one, never a partial.
    # But /etc/hosts is very often a BIND-MOUNTED FILE — it is under Docker — and you cannot rename over a mount point: the
    # rename fails with "Device or resource busy" and, with AGENT_DNS_REQUIRED=1, the container would refuse
    # to start at all.
    # So fall back to writing through the mount. That gives up atomicity for a sub-millisecond window on a
    # file under a kilobyte, which is why the no-change check above matters: it makes the window rare
    # rather than every-60-seconds.
    if mv "$tmp" "$HOSTS_FILE" 2>/dev/null; then
        HOSTS_WRITE=rename
        return 0
    fi
    HOSTS_WRITE=in-place
    cat "$tmp" > "$HOSTS_FILE" 2>/dev/null || { rm -f "$tmp"; return 1; }
    rm -f "$tmp"
}

install_dns() {
    # Config error first, environment second. AGENT_DNS=hosts writes a hosts file, but the rule that
    # actually refuses :53 is rendered into the nftables ruleset — so with AGENT_EGRESS=off this would
    # report `dns=hosts` over a machine where every uid still resolves anything. That is a guard naming a
    # control it is not part of, and it is checkable everywhere, including on a laptop.
    [ "$EGRESS" = "allowlist" ] || { dns_fail "AGENT_DNS=hosts needs AGENT_EGRESS=allowlist (the :53 block lives in that ruleset)"; return; }
    [ "$(id -u)" = "0" ] || { dns_fail "not root (uid $(id -u)) — cannot manage $HOSTS_FILE"; return; }
    apply_hosts || { dns_fail "could not write $HOSTS_FILE"; return; }
    # The gateway is the one name whose loss means the service cannot do its job at all, so it is the one
    # name worth refusing to boot over. The rest warn: a DNS blip on the log sink should not take us down,
    # and a quiet log sink is already what the log-sink alert watches for.
    for u in "${AGENT_MODEL_PROXY_URL:-}"; do
        [ -n "$u" ] || continue
        h="$(url_host "$u")"
        [ -n "$(addrs_of "$DNS_CACHE" "$h")" ] || { dns_fail "gateway host '$h' did not resolve — refusing to serve names without it"; return; }
    done
    for h in $(allow_names); do
        [ -n "$(addrs_of "$DNS_CACHE" "$h")" ] || \
            echo "{\"event\":\"dns.unresolved\",\"host\":\"$h\",\"note\":\"allowlisted but has no address — the service cannot reach it\"}" >&2
    done
    echo "{\"event\":\"dns.installed\",\"names\":\"$(managed_names | tr '\n' ' ')\",\"entries\":\"$(wc -l < "$DNS_CACHE" | tr -d ' ')\",\"write\":\"$HOSTS_WRITE\"}" >&2
}

# Rendering is split from installing on purpose. A ruleset nft REJECTS means no filter at all while the
# config still says there is one — the most dangerous way for this file to fail. Rendering needs no root and no kernel, so every combination
# of allowlist and DNS setting can be handed to `nft -c` from a test instead of from a deploy.
render_rules() {
    out="${1:-/tmp/egress.nft}"
    v4=""; v6=""
    for a in $(allow_addrs); do
        case "$a" in
            *:*) v6="$v6 $a," ;;
            *)   v4="$v4 $a," ;;
        esac
    done

    # Build the elements clause as its own variable. The obvious `${v4:+elements = { ... }}` is WRONG and
    # fails only in production: the shell ends the expansion at the first unmatched `}`, so the trailing
    # brace is literal, and when the set is EMPTY it survives as a stray `}` that breaks the whole ruleset.
    # A host can return IPv6 locally and none from the deployed machine, so a hand test can pass while the
    # deploy fails.
    a4=""; a6=""
    [ -n "$v4" ] && a4="elements = { ${v4%,} }"
    [ -n "$v6" ] && a6="elements = { ${v6%,} }"

    # The name filter, rendered into the same chain. Empty when AGENT_DNS=off.
    dns_rules=""
    if [ "$DNS" = "hosts" ]; then
        dns_rules='        meta skuid 0 udp dport 53 accept
        meta skuid 0 tcp dport 53 accept
        udp dport 53 counter reject
        tcp dport 53 counter reject with tcp reset'
    fi

    cat > "$out" <<EOF
table inet egress
delete table inet egress
table inet egress {
    set allow4 { type ipv4_addr; $a4 }
    set allow6 { type ipv6_addr; $a6 }
    chain output {
        type filter hook output priority filter; policy drop;
        # DNS FIRST, ahead of the conntrack accept below. Fly's recursive resolver lives at fdaa::3, inside
        # Fly's internal 6PN range, so without these rules the sandbox could resolve any name at all —
        # which is a working exfiltration channel: an arbitrary label looked up from uid 10001 comes back
        # NXDOMAIN from Google's own nameservers, so attacker-chosen bytes leave this host and reach a
        # third party.
        # The same query path returns \`TXT _apps.internal\`, which is a directory of every app in the org,
        # most of them nothing to do with this service.
        #
        # Root keeps :53 because the refresh loop below is the thing that resolves names, and it is the
        # only process left running as uid 0 after the drop. Everything else gets its names from
        # /etc/hosts, which makes the RESOLVABLE set exactly equal to the CONNECTABLE set.
        #
        # DoH and DoT need no rule here: they are :443 and :853 to destinations this allowlist refuses.
        # Ordering is deliberate — UDP conntrack promotes a 5-tuple to "established" once a reply comes
        # back, so a :53 rule placed after the ct accept invites an argument about whether a repeat query
        # can ride an existing entry. In front of it, there is no argument to have.
$dns_rules
        ct state established,related accept
        oif lo accept
        # Neighbour discovery. Without this the machine cannot resolve its own next hop and IPv6 dies
        # intermittently — a filter without this rule drops a steady stream of ICMPv6 type 135 to
        # ff02::1:ff00:1, which is hard to connect to "the network went strange later".
        # ND is link-local by construction, so it carries no egress reach.
        meta l4proto ipv6-icmp accept
        ip6 daddr ff02::/16 accept
        # A wholesale \`ip6 daddr fdaa::/16 accept\` would reach every other app
        # in the org over Fly's internal network, so the model gateway (also on 6PN) is pinned like the
        # public hosts below: allow_addrs() resolves it on the same refresh timer as everything else, so
        # the gateway's address is in @allow6 below.
        # Residual: a gateway-machine recreation can leave its address briefly stale, bounded to one
        # DNS_REFRESH cycle (default 60s) until the next resolve. Root's own :53 access (the DNS rules
        # above) is a separate, destination-unrestricted rule. (CUR-1179)
        ip daddr @allow4 accept
        ip6 daddr @allow6 accept
        # A bare counted rule, so \`nft list table inet egress\` shows how much was refused rather than
        # only that a filter exists. NOT \`counter drop\` and NOT \`counter comment "..."\` — this nft
        # build rejects both, and a rejected ruleset means NO filter at all, the most dangerous way for
        # this to fail.
        counter
        # REJECT, not the chain's silent drop policy: a dropped SYN makes the client wait out its full retry
        # ladder. The agent's HF client reaches huggingface.co for tokenizer metadata, and with a drop each
        # turn takes several times longer. A refusal is exactly as closed and returns instantly.
        # Chasing those CDN addresses into the allowlist is the wrong fix twice over — they rotate, and
        # boot-time resolution disagrees with what the agent actually dials.
        reject
    }
}
EOF
}

install_rules() {
    [ "$(id -u)" = "0" ] || { fail "not root (uid $(id -u)) — cannot install nftables rules"; return; }
    command -v nft >/dev/null 2>&1 || { fail "nft not installed in this image"; return; }
    render_rules /tmp/egress.nft || { fail "could not render ruleset"; return; }
    # Syntax-check before applying, and keep the two failures separate — "the rules did not parse" and
    # "the rules are in place" must not read the same in the log.
    nft -c -f /tmp/egress.nft || { fail "nft ruleset rejected (syntax)"; return; }
    nft -f /tmp/egress.nft   || { fail "nft ruleset rejected (apply)";  return; }
    echo "{\"event\":\"egress.installed\",\"allow_hosts\":\"$ALLOW_HOSTS\",\"dns\":\"$DNS\",\"v4\":\"${v4%,}\",\"v6\":\"${v6%,}\"}" >&2
}

refresh_loop() {
    # Re-resolve on a timer, as root, and push the result to BOTH consumers. This is what makes a name
    # allowlist safe to run: /etc/hosts is now the only resolver the app has, so a pinned address that goes
    # stale leaves the service with no recovery short of a redeploy. It also keeps the nft sets current:
    # resolved once at boot, a CDN rotation would silently cut off the log sink.
    prev="$(allow_addrs)"
    while :; do
        sleep "$DNS_REFRESH"
        resolve_all || continue
        apply_hosts || echo '{"event":"dns.refresh_failed","note":"hosts file not updated"}' >&2
        [ "$EGRESS" = "allowlist" ] || continue
        cur="$(allow_addrs)"
        [ "$cur" = "$prev" ] && continue     # nothing moved — do not touch a live filter for no reason
        # Diff the sets rather than flushing and rebuilding. A flush leaves a window, however short, where
        # the allowlist is empty and an in-flight request gets refused. Adding before removing means every
        # address that is live in either generation is permitted throughout the changeover. The removal
        # half is not optional: add-only would let the set grow every time a CDN rotates, so the filter
        # would quietly widen for as long as the container lived.
        for a in $cur; do
            printf '%s\n' "$prev" | grep -qxF "$a" && continue
            case "$a" in *:*) nft add element inet egress allow6 "{ $a }" 2>/dev/null || true ;;
                           *) nft add element inet egress allow4 "{ $a }" 2>/dev/null || true ;; esac
        done
        for a in $prev; do
            printf '%s\n' "$cur" | grep -qxF "$a" && continue
            case "$a" in *:*) nft delete element inet egress allow6 "{ $a }" 2>/dev/null || true ;;
                           *) nft delete element inet egress allow4 "{ $a }" 2>/dev/null || true ;; esac
        done
        echo "{\"event\":\"dns.refreshed\",\"addrs\":\"$(printf '%s' "$cur" | tr '\n' ' ')\"}" >&2
        prev="$cur"
    done
}

# The gateway can legitimately have ZERO running machines for a short window right after its OWN
# redeploy: Fly scales it to zero when idle, and a rolling update briefly has neither the old nor the new
# machine fully "started" (CUR-1203). resolve_all() tries the lookup exactly once, so landing in that
# window fails install_dns()'s gateway-host check and dns_fail() (DNS_REQUIRED=1) exits 1. Fly's container
# restart loop exhausts its retry budget in well under a minute (each restart is a 1-2 s reboot), before a
# gateway redeploy (about 90 s end to end) finishes, and the machine then stays down until someone starts
# it by hand. The bound below (6 tries, 15 s apart) covers that 90 s.
#
# So the resolution is retried HERE, bounded, instead of relying on the whole-container restart loop to
# outlast it. Same shape as scripts/jelastic/lib.sh and api/proxy.py use for the same "this is probably
# transient" case.
BOOT_DNS_RETRY_MAX="${AGENT_DNS_BOOT_RETRY_MAX:-6}"
BOOT_DNS_RETRY_DELAY_S="${AGENT_DNS_BOOT_RETRY_DELAY_S:-15}"

# True once the gateway's own hostname has a cached address. Absent AGENT_MODEL_PROXY_URL trivially
# "resolves" — nothing to wait on, matching install_dns()'s own `continue` for an unset URL.
gateway_host_resolves() {
    h="$(url_host "${AGENT_MODEL_PROXY_URL:-}")"
    [ -z "$h" ] && return 0
    [ -n "$(addrs_of "$DNS_CACHE" "$h")" ]
}

# Everything above defines; everything below acts. The split is here so a test can source this file and
# exercise the name-table logic directly — the marker rewrite and the carry-forward are the parts most
# likely to be subtly wrong and least likely to announce it, since a bad /etc/hosts presents as "the
# gateway went away" half an hour later rather than as an error at boot.
[ "${AGENT_ENTRYPOINT_LIB:-0}" = "1" ] && return 0

if [ "$EGRESS" = "allowlist" ] || [ "$DNS" = "hosts" ]; then
    resolve_all || echo '{"event":"dns.resolve_failed","note":"no name table — allowlists will be empty"}' >&2
    if [ "$DNS" = "hosts" ]; then
        attempt=1
        while ! gateway_host_resolves && [ "$attempt" -lt "$BOOT_DNS_RETRY_MAX" ]; do
            echo "{\"event\":\"dns.boot_retry\",\"attempt\":$attempt,\"max\":$BOOT_DNS_RETRY_MAX,\"delay_s\":$BOOT_DNS_RETRY_DELAY_S}" >&2
            sleep "$BOOT_DNS_RETRY_DELAY_S"
            resolve_all || true
            attempt=$((attempt + 1))
        done
    fi
fi
# /etc/hosts BEFORE the ruleset, always. The reverse order opens a window where :53 is already refused and
# nothing has been written to resolve names out of instead.
[ "$DNS" = "hosts" ] && install_dns
[ "$EGRESS" = "allowlist" ] && install_rules
[ "$DNS" = "hosts" ] && refresh_loop &

# The app's machine list, for routing each conversation to its home machine (api/home_machine.py, CUR-4435).
# The list comes from Fly's internal DNS, which the egress filter keeps from the app's uid, so root writes the
# list and the server only reads it. Off Fly the writer exits without a file and every request is served where
# it lands.
MACHINES_FILE="${AGENT_MACHINES_FILE:-/run/agent-machines}"
MACHINES_REFRESH="${AGENT_MACHINES_REFRESH:-30}"
if [ "$(id -u)" = "0" ] && [ -n "${FLY_APP_NAME:-}" ] && [ -f /srv/api/home_machine.py ]; then
    python3 /srv/api/home_machine.py --write "$MACHINES_FILE" || true
    ( while sleep "$MACHINES_REFRESH"; do python3 /srv/api/home_machine.py --write "$MACHINES_FILE" || true; done ) &
fi

# Say who we are and what the data volume looks like, ALWAYS, before handing off. A sqlite "attempt to
# write a readonly database" is otherwise untestable after the fact, because nothing records the uid the
# server actually started under or the ownership it saw. One line here makes it a fact.
DB_DIR="$(dirname "${AGENT_DB_PATH:-/data/tasks.db}")"
# Fly sets the volume mount point's ownership from the image's declared USER. The image declares `root` so
# we can install packet filters, so /data arrives owned by 0:0, and the dropped server would hit "attempt
# to write a readonly database" on the first PRAGMA.
# Handing the volume to the uid that will actually use it is this script's job — it is the only moment in
# the container's life that is both root and after the mount.
if [ "$(id -u)" = "0" ] && [ "$RUN_UID" != "0" ] && [ -d "$DB_DIR" ]; then
    chown -R "$RUN_UID:$RUN_UID" "$DB_DIR" 2>/dev/null || \
        echo '{"event":"boot.chown_failed","note":"data dir may be unwritable by the server"}' >&2
fi
echo "{\"event\":\"boot.identity\",\"uid_now\":\"$(id -u)\",\"will_drop_to\":\"$RUN_UID\",\"db_dir\":\"$DB_DIR\",\"db_dir_owner\":\"$(stat -c '%u:%g' "$DB_DIR" 2>/dev/null || echo missing)\",\"db_dir_mode\":\"$(stat -c '%a' "$DB_DIR" 2>/dev/null || echo '?')\",\"writable_by_target\":\"$(setpriv --reuid="$RUN_UID" --regid="$RUN_UID" --clear-groups sh -c "test -w '$DB_DIR' && echo yes || echo NO" 2>/dev/null || echo untested)\"}" >&2

# Drop privileges. `exec` so the app is PID 1's successor and signals reach it — a wrapper that forks would
# leave Fly's stop signal going to the wrong process.
if [ "$(id -u)" = "0" ] && [ "$RUN_UID" != "0" ]; then
    # setpriv preserves the environment, so without this the server runs as 10001 while HOME still points
    # at /root — a directory that uid cannot write. Nothing on the startup path needs it today (the agent
    # gets a per-task HERMES_HOME), which is exactly why it would sit here until some library decided to
    # cache something under ~ and failed somewhere unrelated.
    export HOME="${AGENT_RUN_HOME:-/home/agent}"
    exec setpriv --reuid="$RUN_UID" --regid="$RUN_UID" --clear-groups "$@"
fi
exec "$@"
