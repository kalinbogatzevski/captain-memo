#!/usr/bin/env bash
#
# Captain Memo — embedder install script.
#
# DEFAULT (user mode, NO sudo):
#   Install dir: ~/.captain-memo/embed/
#   systemd:     ~/.config/systemd/user/captain-memo-embed.service
#   Run with:    systemctl --user start captain-memo-embed
#
# WITH --system (sudo, multi-user/headless):
#   Install dir: /opt/captain-memo-embed/
#   systemd:     /etc/systemd/system/captain-memo-embed.service
#   Service user: captain-memo-embed (dedicated)
#
# Common: voyageai/voyage-4-nano (HF open weights), FastAPI sidecar on
# localhost:8124 exposing /v1/embeddings. Idempotent.

set -euo pipefail

mode=user        # default: no sudo
uninstall=0
for arg in "$@"; do
  case "$arg" in
    --user)      mode=user ;;
    --system)    mode=system ;;
    --uninstall) uninstall=1 ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--user|--system] [--uninstall]

  --user      (default) install to ~/.captain-memo/embed/ + user-level systemd
  --system    install to /opt/captain-memo-embed/ + system-level systemd (needs sudo)
  --uninstall remove the embedder install for the chosen mode
EOF
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="${REPO_DIR}/services/embed"
SERVICE_NAME=captain-memo-embed
PORT=8124

if [[ "$mode" == "system" ]]; then
  INSTALL_DIR=/opt/captain-memo-embed
  SERVICE_USER=captain-memo-embed
  SYSTEMD_DIR=/etc/systemd/system
  UNIT_TEMPLATE="${SRC_DIR}/systemd/captain-memo-embed.service"
  SYSTEMCTL=(systemctl)
  if [[ $EUID -ne 0 ]]; then
    echo "--system mode needs sudo. Re-running..." >&2
    exec sudo -E "$0" --system
  fi
else
  INSTALL_DIR="${HOME}/.captain-memo/embed"
  SERVICE_USER=""  # no dedicated user in user mode
  SYSTEMD_DIR="${HOME}/.config/systemd/user"
  UNIT_TEMPLATE="${SRC_DIR}/systemd/captain-memo-embed.user.service"
  SYSTEMCTL=(systemctl --user)
  if [[ $EUID -eq 0 ]]; then
    echo "--user mode shouldn't run as root (would install into root's home). Run as your normal user, or pass --system." >&2
    exit 2
  fi
fi

mkdir -p "${SYSTEMD_DIR}"

if [[ $uninstall -eq 1 ]]; then
  echo "==> Stopping and removing ${SERVICE_NAME} (mode=${mode})..."
  "${SYSTEMCTL[@]}" stop "${SERVICE_NAME}" 2>/dev/null || true
  "${SYSTEMCTL[@]}" disable "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "${SYSTEMD_DIR}/${SERVICE_NAME}.service"
  "${SYSTEMCTL[@]}" daemon-reload 2>/dev/null || true
  rm -rf "${INSTALL_DIR}"
  if [[ -n "$SERVICE_USER" ]] && id "${SERVICE_USER}" &>/dev/null; then
    userdel "${SERVICE_USER}" 2>/dev/null || true
  fi
  echo "==> Uninstalled."
  exit 0
fi

echo "==> Captain Memo embedder install (mode=${mode})"
echo "    install_dir = ${INSTALL_DIR}"
echo "    systemd_dir = ${SYSTEMD_DIR}"
echo "    port        = ${PORT}"
echo

# ---- 1. system deps -------------------------------------------------------
if [[ "$mode" == "system" ]]; then
  missing=()
  for cmd in python3 pip; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "==> Installing missing system packages: ${missing[*]}"
    apt-get update -qq
    apt-get install -y python3 python3-venv python3-pip
  fi
else
  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 not found. Install it first (Debian/Ubuntu: sudo apt install python3 python3-venv python3-pip)" >&2
    exit 2
  fi
fi

# ---- 2. dedicated service user (system mode only) ------------------------
if [[ "$mode" == "system" ]] && ! id "${SERVICE_USER}" &>/dev/null; then
  echo "==> Creating service user ${SERVICE_USER}..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

# ---- 3. install dir + source ---------------------------------------------
echo "==> Preparing ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}/models" "${INSTALL_DIR}/logs"
cp "${SRC_DIR}/embeddings.py" "${INSTALL_DIR}/"
cp "${SRC_DIR}/app.py" "${INSTALL_DIR}/"
cp "${SRC_DIR}/requirements.txt" "${INSTALL_DIR}/"

# ---- 4. venv + python deps -----------------------------------------------
if [[ ! -d "${INSTALL_DIR}/venv" ]]; then
  echo "==> Creating venv..."
  python3 -m venv "${INSTALL_DIR}/venv"
fi
echo "==> Installing/refreshing Python deps (~3 GB on first run)..."
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip --quiet
"${INSTALL_DIR}/venv/bin/pip" install -r "${INSTALL_DIR}/requirements.txt" --quiet

# ---- 5. ownership (system mode only) -------------------------------------
if [[ "$mode" == "system" ]]; then
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"
fi

# ---- 6. systemd unit -----------------------------------------------------
echo "==> Installing systemd unit..."
unit="${SYSTEMD_DIR}/${SERVICE_NAME}.service"
if [[ "$mode" == "user" ]]; then
  sed "s|__INSTALL_DIR__|${INSTALL_DIR}|g" "${UNIT_TEMPLATE}" > "${unit}"
else
  cp "${UNIT_TEMPLATE}" "${unit}"
fi

"${SYSTEMCTL[@]}" daemon-reload
"${SYSTEMCTL[@]}" enable "${SERVICE_NAME}"
echo "==> Starting service (first run pulls voyage-4-nano model from HuggingFace, ~250 MB)..."
"${SYSTEMCTL[@]}" restart "${SERVICE_NAME}"

# ---- 7. health probe -----------------------------------------------------
echo "==> Waiting for embedder to be reachable..."
for i in {1..120}; do
  if curl -s -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "==> Embedder is up: $(curl -s http://127.0.0.1:${PORT}/health)"
    if [[ "$mode" == "user" ]]; then
      echo
      echo "Tip: to keep the service running after you log out, enable lingering ONCE:"
      echo "     sudo loginctl enable-linger \$USER"
      echo "(without it, the service stops at logout and restarts at login — fine for desktops)"
    fi
    exit 0
  fi
  sleep 2
done

echo "!! Embedder did not come up within 240s." >&2
if [[ "$mode" == "user" ]]; then
  echo "   journalctl --user -u ${SERVICE_NAME} -n 50 --no-pager" >&2
else
  echo "   journalctl -u ${SERVICE_NAME} -n 50 --no-pager" >&2
fi
exit 1
