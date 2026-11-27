#!/bin/bash
# Run only in the disposable Debian QA guest. Every interface and route belongs
# to a new test namespace. The test router has no link to the VM's network.
set -euo pipefail
[[ $(uname -s) == Linux && $EUID == 0 && ${ID_MANUAL_REMOTE_QA_VM:-} == 1 ]]
for bin in ip iptables openssl setpriv python3; do command -v "$bin" >/dev/null; done
fixture=$(cd -- "$(dirname -- "$0")" && pwd)/egress-fixture.py
lab=$(mktemp -d /run/id-egress-XXXXXX)
id=${lab##*/}
router=$id-router
alpha=$id-alpha
bravo=$id-bravo
web=$id-web
names=()
children=()
resolver_dirs=()
cleanup() {
  set +e
  for pid in "${children[@]}"; do kill "$pid" 2>/dev/null; done
  for pid in "${children[@]}"; do wait "$pid" 2>/dev/null; done
  for dir in "${resolver_dirs[@]}"; do rm -f -- "$dir/resolv.conf" "$dir/nsswitch.conf"; rmdir -- "$dir"; done
  for name in "${names[@]}"; do ip netns del "$name"; done
  rm -rf -- "$lab"
}
trap cleanup EXIT
chmod 0711 "$lab"
for name in "$router" "$alpha" "$bravo" "$web"; do
  ip netns add "$name"
  names+=("$name")
  ip -n "$name" link set lo up
done

wire() {
  local peer=$1 nic=$2 gateway=$3 address=$4
  ip -n "$router" link add name "$nic" type veth peer name eth0 netns "$peer"
  ip -n "$router" addr add "$gateway/30" dev "$nic"
  ip -n "$peer" addr add "$address/30" dev eth0
  ip -n "$router" link set dev "$nic" up
  ip -n "$peer" link set eth0 up
  ip -n "$peer" route add default via "$gateway"
}
wire "$alpha" a 192.0.2.1 192.0.2.2
wire "$bravo" b 192.0.2.5 192.0.2.6
wire "$web" w 192.0.2.9 192.0.2.10
ip netns exec "$router" sysctl -qw net.ipv4.ip_forward=1
ip -n "$router" addr add 169.254.169.254/32 dev lo
ip -n "$router" -6 addr add fd00:ec2::254/128 dev lo nodad
for address in 203.0.113.10 203.0.113.53 10.27.0.5; do
  ip -n "$web" addr add "$address/32" dev lo
  ip -n "$router" route add "$address/32" via 192.0.2.10
done
mkdir -p /etc/netns
for side in a b; do
  peer=$alpha
  [[ $side == a ]] || peer=$bravo
  ip -n "$router" -6 addr add "fd42:$side::1/64" dev "$side" nodad
  ip -n "$peer" -6 addr add "fd42:$side::2/64" dev eth0 nodad
  ip -n "$peer" -6 route add fd00:ec2::254/128 via "fd42:$side::1" dev eth0
  mkdir "/etc/netns/$peer"
  resolver_dirs+=("/etc/netns/$peer")
  printf '%s\n' 'nameserver 203.0.113.53' 'options timeout:1 attempts:1' > "/etc/netns/$peer/resolv.conf"
  # Name resolution is confined to the fixture resolver even when the VM
  # itself uses a local systemd-resolved Unix socket via NSS.
  sed 's/^hosts:.*/hosts: files dns/' /etc/nsswitch.conf > "/etc/netns/$peer/nsswitch.conf"
done
[[ -z $(ip -n "$router" route show default) ]]

# An ephemeral test certificate permits a complete HTTPS certificate and DNS-name check.
openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj /CN=web.test \
  -addext subjectAltName=DNS:web.test -keyout "$lab/key.pem" -out "$lab/cert.pem" >/dev/null 2>&1
chmod 0644 "$lab/cert.pem"
for name in "$router" "$alpha" "$bravo" "$web"; do
  role=${name##*-}
  ip netns exec "$name" python3 -IB "$fixture" serve "$role" "$lab" &
  children+=("$!")
done
for name in "$router" "$alpha" "$bravo" "$web"; do
  for _ in {1..40}; do
    if ip netns exec "$name" python3 -IB -c 'import socket; socket.create_connection(("127.0.0.1", 80), .2).close()' 2>/dev/null; then break; fi
    sleep .1
  done
done

unpriv=(setpriv --reuid=10001 --regid=10001 --clear-groups --bounding-set=-all --no-new-privs)
verify() {
  local name
  for name in "$alpha" "$bravo"; do
    ip netns exec "$name" "${unpriv[@]}" python3 -IB "$fixture" verify "${name##*-}" "$1" "$lab/cert.pem"
  done
}
verify baseline

# Specific synthetic WAN address and DNS resolver only. Private DNS answers
# still traverse this IP/port filter, and no worker controls the router.
fw=(ip netns exec "$router" iptables -w)
"${fw[@]}" -P FORWARD DROP
"${fw[@]}" -P INPUT DROP
"${fw[@]}" -A INPUT -i lo -j ACCEPT
"${fw[@]}" -A INPUT -j REJECT
for side in a b; do
  source=192.0.2.2
  [[ $side == a ]] || source=192.0.2.6
  "${fw[@]}" -A FORWARD -i "$side" -o w -s "$source" -d 203.0.113.10 -p tcp -m multiport --dports 80,443 -j ACCEPT
  "${fw[@]}" -A FORWARD -i "$side" -o w -s "$source" -d 203.0.113.53 -p udp --dport 53 -j ACCEPT
  "${fw[@]}" -A FORWARD -i w -o "$side" -d "$source" -m conntrack --ctstate ESTABLISHED -j ACCEPT
done
"${fw[@]}" -A FORWARD -j REJECT
for peer in "$alpha" "$bravo"; do
  ip netns exec "$peer" sysctl -qw net.ipv6.conf.all.disable_ipv6=1
done
verify enforced

install -d -m 0700 -o 10001 -g 10001 "$lab/browser"
html=$(timeout 25 ip netns exec "$alpha" "${unpriv[@]}" env -i PATH=/usr/bin:/bin HOME="$lab/browser" \
  /usr/lib/chromium/chromium --headless --dump-dom --disable-background-networking \
  --no-first-run --no-default-browser-check --user-data-dir="$lab/browser/chromium" http://web.test/ 2>/dev/null)
[[ $html == *'fixture-203.0.113.10-80'* ]]
echo "Sandboxed Chromium rendered the allowed fixture through the filtered router."
