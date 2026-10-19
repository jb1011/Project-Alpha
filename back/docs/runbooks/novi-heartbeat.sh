#!/usr/bin/env bash
# Novi box heartbeat: a dead-man's switch for the box.
#
# Run by novi-heartbeat.timer every 2 minutes as the `novi` user. When every check passes it pings
# a Healthchecks.io check. When a check fails it writes the reasons to that check's event log
# (`/log`, which never changes the check's state) and sends no ping. The check then goes down after
# its period plus grace, about 10 minutes, and Healthchecks alerts. A failure that clears on a later
# run inside that window never alerts.
#
# Settings come from /etc/novi/heartbeat.env (see controller-monitoring.md, "Dead-man's switch"):
#   HC_PING_URL     required. The check's ping URL. A secret: whoever holds it can keep the check
#                   green. This script never prints it.
#   DATA_DIR        required. The backend's data directory (monitor.db lives there).
#   PUBLIC_API      default https://api.novicorpus.com (an https:// URL)
#   UNITS           default "legalbody-api legalbody-monitor litestream"
#   DISK_MAX_PCT    default 90
#   CERT_MIN_DAYS   default 7; 0 turns the certificate check off.
#   GAS_ADDRESS, GAS_FLOOR_USDC, ARC_RPC_URL
#                   optional, all three or none: fail when that address holds less native USDC
#                   (Arc's gas) than the floor. A balance that cannot be read is only logged.
#
# It holds no keys, sends no transactions and opens monitor.db read-only.

set -uo pipefail

: "${HC_PING_URL:?HC_PING_URL is not set}"
: "${DATA_DIR:?DATA_DIR is not set}"
HC_PING_URL="${HC_PING_URL%/}"
PUBLIC_API="${PUBLIC_API:-https://api.novicorpus.com}"
UNITS="${UNITS:-legalbody-api legalbody-monitor litestream}"
DISK_MAX_PCT="${DISK_MAX_PCT:-90}"
CERT_MIN_DAYS="${CERT_MIN_DAYS:-7}"
STATE_DIR="${STATE_DIRECTORY:-/var/lib/novi-heartbeat}"

reasons=()
fail() { reasons+=("$1"); }

# (a) The public path: DNS, TLS, the API and its chain reads. /transparency reports
#     "legalBodiesAvailable":false when it cannot read the chain.
if body=$(curl -fsS -m 20 "$PUBLIC_API/transparency" 2>&1); then
  [[ "$body" == *'"legalBodiesAvailable":true'* ]] \
    || fail "transparency: legal bodies unavailable (the API cannot read the chain)"
else
  fail "transparency unreachable: ${body:0:160}"
fi

# (b) The monitor is moving: its cursor has advanced since the previous run. The cursor moves on
#     every tick that reads a window, including a rate-limited catch-up, and freezes when the chain
#     head cannot be read. `monitor_scanned` is not used: it is logged only when a tick reaches the
#     head, so it goes quiet during a healthy catch-up.
cur=$(sqlite3 -readonly -cmd ".timeout 5000" "$DATA_DIR/monitor.db" \
  "SELECT last_scanned_block FROM cursor WHERE id = 1;" 2>&1)
if [[ "$cur" =~ ^[0-9]+$ ]]; then
  prev=$(cat "$STATE_DIR/cursor" 2>/dev/null || true)
  if [[ "$prev" =~ ^[0-9]+$ ]] && (( cur <= prev )); then
    fail "monitor cursor stuck at block $cur"
  fi
  if ! echo "$cur" > "$STATE_DIR/cursor" 2>/dev/null; then
    echo "heartbeat: cannot write $STATE_DIR/cursor" >&2
    fail "cannot save the monitor cursor"
  fi
else
  # The detail (it can name local paths) goes to the journal only, not to the ping service.
  echo "heartbeat: monitor cursor read failed: ${cur:0:200}" >&2
  fail "monitor cursor unreadable"
fi

# (c) The services are running. One call per unit: `is-active` given several names succeeds when
#     any one of them is active.
for unit in $UNITS; do
  systemctl is-active --quiet "$unit" || fail "$unit is not active"
done

# (d) Disk space where the databases live.
used=$(df --output=pcent "$DATA_DIR" 2>/dev/null | tail -n 1 | tr -dc '0-9')
if [[ -z "$used" ]]; then
  fail "disk usage unreadable"
elif (( used >= DISK_MAX_PCT )); then
  fail "disk ${used}% full (limit ${DISK_MAX_PCT}%)"
fi

# (e) The public certificate stays valid for CERT_MIN_DAYS more days. An expired one already fails
#     check (a); this one warns a week ahead.
if (( CERT_MIN_DAYS > 0 )); then
  host="${PUBLIC_API#https://}"
  host="${host%%/*}"
  if ! echo | timeout 20 openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null \
    | openssl x509 -noout -checkend $(( CERT_MIN_DAYS * 86400 )) >/dev/null 2>&1; then
    fail "certificate for $host expires within $CERT_MIN_DAYS days, or could not be read"
  fi
fi

# (f) Optional: an address that pays gas holds at least GAS_FLOOR_USDC of native USDC. Native USDC
#     has 18 decimals on Arc (the ERC-20 interface has 6).
if [[ -n "${GAS_ADDRESS:-}" ]]; then
  if [[ -z "${GAS_FLOOR_USDC:-}" || -z "${ARC_RPC_URL:-}" ]]; then
    fail "gas check misconfigured: GAS_ADDRESS needs GAS_FLOOR_USDC and ARC_RPC_URL"
  else
    hex=$(curl -fsS -m 20 -H 'content-type: application/json' \
      --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$GAS_ADDRESS\",\"latest\"]}" \
      "$ARC_RPC_URL" 2>/dev/null | jq -r '.result // empty' 2>/dev/null)
    if [[ "$hex" =~ ^0x[0-9a-fA-F]+$ ]]; then
      low=$(python3 -c 'import sys; from decimal import Decimal; print(int(int(sys.argv[1], 16) < Decimal(sys.argv[2]) * 10**18))' \
        "$hex" "$GAS_FLOOR_USDC" 2>/dev/null)
      [[ "$low" == "0" ]] || fail "gas balance below $GAS_FLOOR_USDC USDC, or the floor is not a number"
    else
      # Not a reason: a dead or rate-limited RPC is already caught by checks (a) and (b), and this
      # read shares the monitor's RPC, so failing here would only add pages during a catch-up.
      echo "heartbeat: gas balance unreadable, check skipped this run" >&2
    fi
  fi
fi

if (( ${#reasons[@]} == 0 )); then
  curl -fsS -m 10 --retry 3 -o /dev/null "$HC_PING_URL" 2>/dev/null \
    || echo "heartbeat: all checks passed, but the ping could not be sent" >&2
else
  printf 'heartbeat: %s\n' "${reasons[@]}" >&2
  report=$(printf '%s\n' "${reasons[@]}")
  curl -fsS -m 10 --retry 3 -o /dev/null --data-raw "$report" "$HC_PING_URL/log" 2>/dev/null \
    || echo "heartbeat: the failure report could not be sent" >&2
fi
exit 0
