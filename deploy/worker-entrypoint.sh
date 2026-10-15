#!/bin/sh
# The worker Machine's two phases (spec 2 S9). Phase 1 runs as root with the network open: lease
# the job and clone the public repository. Then the firewall allows only the server's private
# address and port, and phase 2 runs the engine as an unprivileged user with no new privileges.
# Under `set -e` any failure before phase 2 (phase 1 refusing the clone, the server's name not
# resolving) ends the Machine with the firewall untouched and phase 2 never run.
set -eu
umask 077
WORK=/work
APP=/app/packages/worker/src/main.ts
mkdir -p "$WORK"
export REPOWIKI_WORK_DIR="$WORK"

# The server's host and port, parsed by Node's URL parser rather than by hand.
target=$(node -e 'const u = new URL(process.env.REPOWIKI_API_URL ?? "");
process.stdout.write(`${u.hostname.replace(/^\[|\]$/g, "")} ${u.port || (u.protocol === "https:" ? 443 : 80)}`);')
host=${target% *}
port=${target#* }
addr=$(getent ahostsv6 "$host" | awk 'NR == 1 { print $1 }')
# Only an IPv6 address and a port number ever reach the rules below.
printf '%s' "$addr" | grep -Eq '^[0-9a-fA-F:]+$' || {
  echo '{"worker":"cannot resolve the server"}' >&2
  exit 1
}
printf '%s' "$port" | grep -Eq '^[0-9]+$' || {
  echo '{"worker":"bad server port"}' >&2
  exit 1
}
# Phase 2 has no DNS: the server's name resolves from /etc/hosts.
printf '%s %s\n' "$addr" "$host" >> /etc/hosts

node "$APP" phase1

chown -R worker:worker "$WORK"
# Neighbor Discovery is not conntrack-related traffic: without it the kernel cannot re-resolve the
# server's link address after an idle gap. Hop limit 255 means it came from the link itself.
nft -f - <<RULES
flush ruleset
table inet sandbox {
  chain output {
    type filter hook output priority 0; policy drop;
    oif "lo" accept
    ct state established,related accept
    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, nd-router-advert } ip6 hoplimit 255 accept
    ip6 daddr $addr tcp dport $port accept
  }
  chain input {
    type filter hook input priority 0; policy drop;
    iif "lo" accept
    ct state established,related accept
    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, nd-router-advert } ip6 hoplimit 255 accept
  }
}
RULES

exec setpriv --reuid=worker --regid=worker --init-groups --no-new-privs --bounding-set=-all \
  env HOME=/home/worker node "$APP" phase2
