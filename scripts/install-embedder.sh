#!/usr/bin/env bash
#
# Captain Memo — local embedder install script.
#
# Stands up voyageai/voyage-4-nano (open weights from HuggingFace) behind a
# FastAPI sidecar exposing /v1/embeddings on localhost:8124. Idempotent —
# re-running verifies the stack and restarts. --uninstall removes everything.
#
# Tested on Debian 13 / Ubuntu 24.04. Requires AVX2-capable CPU (numpy 2.x
# wheel constraint) and Python 3.11+. Uses ~3 GB disk for venv + model cache.

set -euo pipefail

INSTALL_DIR=/opt/captain-memo-embed
SERVICE_USER=captain-memo-embed
PORT=8124
SERVICE_NAME=captain-memo-embed
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="${REPO_DIR}/services/embed"

uninstall=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) uninstall=1 ;;
    --help|-h)
      cat <<EOF
Usage: $0 [--uninstall]

Installs the Captain Memo embedder sidecar to ${INSTALL_DIR},
configured as a systemd service on port ${PORT}.

  --uninstall   Stop the service, remove the unit file, the install dir,
                and the dedicated user.
EOF
      exit 0
      ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

require_sudo() {
  if [[ $EUID -ne 0 ]]; then
    echo "This script needs sudo (writes to /opt and /etc/systemd)." >&2
    exec sudo -E "$0" "$@"
  fi
}
require_sudo "$@"

if [[ $uninstall -eq 1 ]]; then
  echo "==> Stopping and removing ${SERVICE_NAME}..."
  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  rm -rf "${INSTALL_DIR}"
  if id "${SERVICE_USER}" &>/dev/null; then
    userdel "${SERVICE_USER}" 2>/dev/null || true
  fi
  echo "==> Uninstalled."
  exit 0
fi

echo "==> Captain Memo embedder install"
echo "    install_dir   = ${INSTALL_DIR}"
echo "    service_user  = ${SERVICE_USER}"
echo "    port          = ${PORT}"
echo "    source        = ${SRC_DIR}"
echo

# ---- 1. system deps ---------------------------------------------------------
echo "==> Checking system deps..."
missing=()
for cmd in python3 pip; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Installing missing system packages: ${missing[*]}"
  apt-get update -qq
  apt-get install -y python3 python3-venv python3-pip
fi

# ---- 2. dedicated service user ---------------------------------------------
if ! id "${SERVICE_USER}" &>/dev/null; then
  echo "==> Creating service user ${SERVICE_USER}..."
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

# ---- 3. install dir + source ------------------------------------------------
echo "==> Preparing ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}/models" "${INSTALL_DIR}/logs"
cp "${SRC_DIR}/embeddings.py" "${INSTALL_DIR}/"
cp "${SRC_DIR}/app.py" "${INSTALL_DIR}/"
cp "${SRC_DIR}/requirements.txt" "${INSTALL_DIR}/"

# ---- 4. venv + python deps --------------------------------------------------
if [[ ! -d "${INSTALL_DIR}/venv" ]]; then
  echo "==> Creating venv (this is fast)..."
  python3 -m venv "${INSTALL_DIR}/venv"
fi
echo "==> Installing/refreshing Python deps (~3 GB on first run)..."
"${INSTALL_DIR}/venv/bin/pip" install --upgrade pip --quiet
"${INSTALL_DIR}/venv/bin/pip" install -r "${INSTALL_DIR}/requirements.txt" --quiet

# ---- 5. ownership -----------------------------------------------------------
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

# ---- 6. systemd unit --------------------------------------------------------
echo "==> Installing systemd unit..."
cp "${SRC_DIR}/systemd/captain-memo-embed.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

echo "==> Starting service (first run pulls voyage-4-nano model from HuggingFace, ~250 MB)..."
systemctl restart "${SERVICE_NAME}"

# ---- 7. health probe --------------------------------------------------------
echo "==> Waiting for embedder to be reachable..."
for i in {1..120}; do
  if curl -s -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "==> Embedder is up: $(curl -s http://127.0.0.1:${PORT}/health)"
    echo
    echo "Set in your shell to point captain-memo's worker at it:"
    echo "  export CAPTAIN_MEMO_EMBEDDER_ENDPOINT=http://127.0.0.1:${PORT}/v1/embeddings"
    echo "  export CAPTAIN_MEMO_EMBEDDER_MODEL=voyageai/voyage-4-nano"
    echo "  export CAPTAIN_MEMO_EMBEDDING_DIM=2048"
    exit 0
  fi
  sleep 2
done

echo "!! Embedder did not come up within 240s. Check logs:" >&2
echo "   journalctl -u ${SERVICE_NAME} -n 50 --no-pager" >&2
exit 1
