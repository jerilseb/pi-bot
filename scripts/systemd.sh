#!/usr/bin/env bash
# Install or uninstall pi-bot as a systemd --user unit.
#
#   scripts/systemd.sh install
#   scripts/systemd.sh uninstall
#
# The unit runs `node main.ts` with WorkingDirectory set to the repo root, so
# dotenv picks up .env exactly as it does under `npm run dev`. No secrets are
# read or copied by this script.

set -euo pipefail

SERVICE=pi-bot
UNIT="${SERVICE}.service"
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="${UNIT_DIR}/${UNIT}"

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

info() { printf '  %s\n' "$1"; }

# systemd --user starts with a minimal PATH, but the bot shells out to node,
# npm, git, and friends through its Bash tool, its background shell sessions,
# and its pre-restart `npm run verify`. Carry over the installing shell's PATH,
# dropping entries that do not exist.
resolve_path() {
  local out='' dir
  local IFS=:
  for dir in $PATH; do
    [[ -n $dir && -d $dir ]] || continue
    case ":${out}:" in
      *":${dir}:"*) continue ;;
    esac
    out="${out:+$out:}${dir}"
  done
  printf '%s' "$out"
}

require_systemd() {
  command -v systemctl >/dev/null 2>&1 || die 'systemctl not found; this script needs systemd.'
  systemctl --user show-environment >/dev/null 2>&1 ||
    die 'no systemd --user instance reachable (need a logged-in session with DBUS_SESSION_BUS_ADDRESS set).'
}

# Without lingering, the unit dies when the last login session ends.
ensure_linger() {
  command -v loginctl >/dev/null 2>&1 || return 0
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" == yes ]]; then
    info 'lingering already enabled'
    return 0
  fi
  if loginctl enable-linger "$USER" >/dev/null 2>&1; then
    info 'enabled lingering so the bot survives logout'
  else
    printf 'warning: could not enable lingering. Run: sudo loginctl enable-linger %s\n' "$USER" >&2
  fi
}

write_unit() {
  local node_bin="$1" unit_path="$2"
  cat >"$unit_path" <<UNIT
[Unit]
Description=pi-bot Telegram bridge to the Pi SDK
Documentation=file://${REPO_ROOT}/README.md
After=network-online.target
Wants=network-online.target
# A bad .env or model config exits immediately; let systemd give up instead of
# looping forever.
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
ExecStart=${node_bin} ${REPO_ROOT}/main.ts
Environment=PATH=$(resolve_path)
# /restart and the restart_bot tool exit 0 on purpose, so restart on any exit.
Restart=always
RestartSec=2
# SIGTERM is handled: the bot drains its session before exiting.
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE}

[Install]
WantedBy=default.target
UNIT
}

do_install() {
  require_systemd
  local node_bin
  node_bin="$(command -v node)" || die 'node not found in PATH.'
  [[ -f "${REPO_ROOT}/main.ts" ]] || die "main.ts not found in ${REPO_ROOT}."
  [[ -d "${REPO_ROOT}/node_modules" ]] || die "dependencies missing; run npm install in ${REPO_ROOT} first."
  # Existence only: this script never reads .env.
  [[ -f "${REPO_ROOT}/.env" ]] || die "${REPO_ROOT}/.env not found; copy .env.example and fill it in."

  printf 'Installing %s\n' "$UNIT"
  info "repo:  ${REPO_ROOT}"
  info "node:  ${node_bin}"
  ensure_linger

  mkdir -p "$UNIT_DIR"
  local tmp_unit
  tmp_unit="$(mktemp "${UNIT_PATH}.XXXXXX")"
  write_unit "$node_bin" "$tmp_unit"
  chmod 644 "$tmp_unit"
  mv -f "$tmp_unit" "$UNIT_PATH"
  info "unit:  ${UNIT_PATH}"

  systemctl --user daemon-reload
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  systemctl --user enable "$UNIT"
  # restart, not `enable --now`: on a reinstall an already-active unit would
  # otherwise keep running the previous unit file.
  systemctl --user restart "$UNIT"

  printf '\n'
  systemctl --user --no-pager --lines=0 status "$UNIT" || true
  cat <<EOF

Manage it with:
  systemctl --user status ${SERVICE}
  systemctl --user restart ${SERVICE}
  systemctl --user stop ${SERVICE}
  journalctl --user -u ${SERVICE} -f
EOF
}

do_uninstall() {
  require_systemd
  printf 'Uninstalling %s\n' "$UNIT"

  if systemctl --user list-unit-files "$UNIT" --no-legend 2>/dev/null | grep -q .; then
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
  else
    systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
  fi
  info 'stopped and disabled'

  if [[ -f "$UNIT_PATH" ]]; then
    rm -f "$UNIT_PATH"
    info "removed ${UNIT_PATH}"
  else
    info "no unit file at ${UNIT_PATH}"
  fi

  systemctl --user daemon-reload
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  info "persistent state under ${REPO_ROOT}/files was left untouched"
}

case "${1:-}" in
  install) do_install ;;
  uninstall) do_uninstall ;;
  *)
    printf 'usage: %s {install|uninstall}\n' "$(basename -- "${BASH_SOURCE[0]}")" >&2
    exit 2
    ;;
esac
