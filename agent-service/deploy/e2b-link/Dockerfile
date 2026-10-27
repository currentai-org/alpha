# The Fly end of the tunnel to the E2B install (CUR-4451). Agent machines reach E2B at this app's private
# address (<app>.internal:3000 and :3002); this app forwards each connection through WireGuard to the AWS host.
# Fly's private network between our apps is itself WireGuard, so nothing crosses the internet in the clear.
FROM alpine:3.22
RUN apk add --no-cache wireguard-tools iptables socat
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
