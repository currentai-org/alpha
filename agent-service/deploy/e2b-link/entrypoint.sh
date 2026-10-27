#!/bin/sh
# WG_PRIVATE_KEY (a secret) and WG_ENDPOINT, WG_HOST_PUBLIC_KEY (env) come from the E2B host's WireGuard setup. Each further host in the pool adds WG_ENDPOINT_<n> and WG_HOST_PUBLIC_KEY_<n>
# for slot n, from 2 with none skipped (CUR-4528).
set -eu
umask 077
mkdir -p /etc/wireguard

# tunnel <slot> <endpoint> <host public key>: slot n is wg<n-1>, 10.99.<n-1>.2 here and .1 on its host
# (deploy/aws/e2b/wireguard.tf). Every tunnel carries the link's one key.
tunnel() {
  n=$(($1 - 1))
  # Nothing the E2B host sends may start a connection to this app or reach past it into our private network.
  # The rules go in before the tunnel is up, so there is no moment it is open without them.
  iptables -A INPUT -i "wg$n" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A INPUT -i "wg$n" -j DROP
  iptables -A FORWARD -i "wg$n" -j DROP
  cat > "/etc/wireguard/wg$n.conf" <<CONF
[Interface]
Address = 10.99.$n.2/30
PrivateKey = ${WG_PRIVATE_KEY}

[Peer]
PublicKey = $3
Endpoint = $2
AllowedIPs = 10.99.$n.1/32
PersistentKeepalive = 25
CONF
  wg-quick up "wg$n"
}

# forward <slot>: the slot's API and sandbox proxy on 3000 and 3002 plus 100 per slot above 1
# (SLOT_PORT_STEP in api/sandbox_e2b.py), to the same two ports on its host.
forward() {
  n=$(($1 - 1))
  socat "TCP6-LISTEN:$((3000 + 100 * n)),bind=fly-local-6pn,fork,reuseaddr" "TCP4:10.99.$n.1:3000" &
  socat "TCP6-LISTEN:$((3002 + 100 * n)),bind=fly-local-6pn,fork,reuseaddr" "TCP4:10.99.$n.1:3002" &
}

tunnel 1 "$WG_ENDPOINT" "$WG_HOST_PUBLIC_KEY"
slots=1
while :; do
  i=$((slots + 1))
  eval "endpoint=\${WG_ENDPOINT_$i:-} key=\${WG_HOST_PUBLIC_KEY_$i:-}"
  [ -z "$endpoint$key" ] && break
  if [ -z "$endpoint" ] || [ -z "$key" ]; then
    echo "slot $i needs both WG_ENDPOINT_$i and WG_HOST_PUBLIC_KEY_$i" >&2
    exit 1
  fi
  tunnel "$i" "$endpoint" "$key"
  slots=$i
done
unset WG_PRIVATE_KEY
echo "e2b-link: $slots slot(s) up"

i=2
while [ "$i" -le "$slots" ]; do
  forward "$i"
  i=$((i + 1))
done
socat TCP6-LISTEN:3000,bind=fly-local-6pn,fork,reuseaddr TCP4:10.99.0.1:3000 &
exec socat TCP6-LISTEN:3002,bind=fly-local-6pn,fork,reuseaddr TCP4:10.99.0.1:3002
