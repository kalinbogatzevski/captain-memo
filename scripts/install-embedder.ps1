<#
.SYNOPSIS
  Captain Memo — embedder install script (Windows port of install-embedder.sh).

.DESCRIPTION
  Builds the Python sidecar that exposes voyageai/voyage-4-nano at the universal
  /v1/embeddings shape on localhost:8124. This is the faithful Windows port of
  scripts/install-embedder.sh, with the POSIX/systemd-specific parts removed:

    * NO systemd. On Windows the worker/embed daemons are supervised by a per-user
      Scheduled Task that the ServiceManager (windows-scheduled-task.ts) registers
      SEPARATELY — this script does not touch task scheduling, nor does it start the
      service. It only: prepares the install dir, copies the sidecar sources, builds
      the venv, installs requirements, and PRE-DOWNLOADS the model so the first real
      request doesn't block on a ~250 MB HuggingFace pull.
    * venv layout is <venv>\Scripts\ (NOT bin/) — python is <venv>\Scripts\python.exe.
    * venv is created with `py -3.11 -m venv` (the py launcher pins 3.11), falling
      back to `python -m venv` when the launcher or that minor isn't present.

  NOTE on requirements: services/embed/requirements.txt uses `uvicorn[standard]`,
  whose uvloop/httptools extras are POSIX-only — pip silently skips them on Windows.
  This works ONLY because they are NOT hard-pinned. If requirements.txt is ever
  changed to pin uvloop/httptools directly, pip install WILL fail on Windows.

.PARAMETER InstallDir
  Where the venv + model live. Defaults to %USERPROFILE%\.captain-memo\embed
  (mirrors the Linux user-mode ~/.captain-memo/embed).

.PARAMETER Model
  Embedder model id baked into the sidecar / pre-download. Default voyageai/voyage-4-nano.

.PARAMETER Port
  Localhost port the sidecar serves /v1/embeddings on. Default 8124. Recorded for
  reference only — this script does not start the server.

.PARAMETER Uninstall
  Remove the install dir for the chosen InstallDir and exit.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE '.captain-memo\embed'),
  [string]$Model = 'voyageai/voyage-4-nano',
  [int]$Port = 8124,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# Source dir = services/embed/ relative to this script's parent (repo root).
$RepoDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$SrcDir  = Join-Path $RepoDir 'services\embed'

# venv layout — Windows puts executables in Scripts\ (NOT bin/ as on POSIX).
$VenvDir    = Join-Path $InstallDir 'venv'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$ModelsDir  = Join-Path $InstallDir 'models'
$LogsDir    = Join-Path $InstallDir 'logs'

if ($Uninstall) {
  Write-Host "==> Removing embedder install at $InstallDir..."
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  Write-Host '==> Uninstalled.'
  exit 0
}

Write-Host '==> Captain Memo embedder install (windows)'
Write-Host "    install_dir = $InstallDir"
Write-Host "    model       = $Model"
Write-Host "    port        = $Port"
Write-Host ''

# ---- 1. install dir + source ---------------------------------------------
Write-Host "==> Preparing $InstallDir..."
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogsDir   | Out-Null
Copy-Item (Join-Path $SrcDir 'embeddings.py')     $InstallDir -Force
Copy-Item (Join-Path $SrcDir 'app.py')            $InstallDir -Force
Copy-Item (Join-Path $SrcDir 'requirements.txt')  $InstallDir -Force

# ---- 2. venv -------------------------------------------------------------
if (-not (Test-Path $VenvPython)) {
  Write-Host '==> Creating venv...'
  # Prefer the py launcher pinned to 3.11; fall back to whatever `python` resolves.
  $created = $false
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3.11 -m venv $VenvDir
    if ($LASTEXITCODE -eq 0) { $created = $true }
  }
  if (-not $created) {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
      Write-Error 'No Python found. Install Python 3.11+ (https://www.python.org/downloads/, tick "Add to PATH") and re-run.'
    }
    & python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { Write-Error 'venv creation failed.' }
  }
}

# ---- 3. python deps ------------------------------------------------------
Write-Host '==> Installing/refreshing Python deps (~3 GB on first run)...'
& $VenvPython -m pip install --upgrade pip --quiet
if ($LASTEXITCODE -ne 0) { Write-Error 'pip self-upgrade failed.' }
& $VenvPython -m pip install -r (Join-Path $InstallDir 'requirements.txt') --quiet
if ($LASTEXITCODE -ne 0) { Write-Error 'pip install -r requirements.txt failed.' }

# ---- 4. pre-download the model -------------------------------------------
# On Linux the systemd unit starts uvicorn and the FastAPI startup hook pulls the
# model on first boot. Windows has no systemd here (the Scheduled Task is registered
# by the ServiceManager separately), so warm the HF cache now — cache the weights
# under <installDir>\models via HF_HOME so the first real request is instant.
Write-Host '==> Pre-downloading model (first run pulls voyage-4-nano from HuggingFace, ~250 MB)...'
$env:HF_HOME = $ModelsDir
$env:CAPTAIN_MEMO_EMBED_MODEL = $Model
$warm = @'
import os
from sentence_transformers import SentenceTransformer
name = os.environ.get("CAPTAIN_MEMO_EMBED_MODEL", "voyageai/voyage-4-nano")
SentenceTransformer(name, device="cpu", trust_remote_code=True)
print("model cached:", name)
'@
& $VenvPython -c $warm
if ($LASTEXITCODE -ne 0) { Write-Error 'model pre-download failed.' }

Write-Host ''
Write-Host '==> Embedder venv ready.'
Write-Host "    python  = $VenvPython"
Write-Host "    uvicorn = $(Join-Path $VenvDir 'Scripts\uvicorn.exe')"
Write-Host '    (the worker install registers the Scheduled Task that runs uvicorn)'
exit 0
