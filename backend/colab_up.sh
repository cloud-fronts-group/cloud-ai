#!/usr/bin/env bash
# Bring up the Cloud AI router with the Unsloth backend on a Colab VM, from your laptop,
# using the Colab CLI (https://github.com/googlecolab/google-colab-cli).
#
#   backend/colab_up.sh [SESSION]            default session name: cloud-ai
#
# Environment:
#   COLAB_GPU             T4 | L4 | G4 | A100 | H100     (default T4)
#   COLAB_AUTH            adc | oauth2                    (default: the CLI's own default)
#   CLOUD_UNSLOTH_MODEL   HF id, or a folder on Drive holding a LoRA adapter or merged model
#                         (default unsloth/Qwen3-4B-Instruct-2507)
#   CLOUD_DRIVE           1 = mount Google Drive, 0 = skip, auto = only when the model is on Drive
#   CLOUD_* / HF_TOKEN    any other router setting is forwarded to the VM
#
# Google Drive: `colab drivemount` runs drive.mount('/content/drive') and answers Colab's
# credential-propagation request itself. If consent is needed it prints (and tries to open)
# a Google OAuth URL and waits up to 10 minutes. It needs a real terminal, so this script
# refuses to do that step without one. Plain `colab exec` cannot mount Drive.
#
# Everything the CLI does in the session is recorded in
# ~/.config/colab-cli/history/<SESSION>.jsonl (mode 0600). That file will contain
# CLOUD_TOKEN, because the start script prints it. A notebook copy is written next to it.
set -euo pipefail
cd "$(dirname "$0")/.."

S="${1:-cloud-ai}"
GPU="${COLAB_GPU:-T4}"
MODEL="${CLOUD_UNSLOTH_MODEL:-unsloth/Qwen3-4B-Instruct-2507}"
DRIVE="${CLOUD_DRIVE:-auto}"
colab() { command colab ${COLAB_AUTH:+--auth="$COLAB_AUTH"} "$@"; }

command -v colab >/dev/null || { echo "colab CLI not found: uv tool install google-colab-cli" >&2; exit 127; }

if colab status -s "$S" >/dev/null 2>&1; then
  echo "[up] reusing session $S"
else
  echo "[up] allocating $GPU session $S"
  colab new -s "$S" --gpu "$GPU"
fi

case "$DRIVE" in auto) [[ "$MODEL" == /content/drive/* ]] && DRIVE=1 || DRIVE=0 ;; esac
if [ "$DRIVE" = 1 ]; then
  if echo 'import os; print("DRIVE_MOUNTED" if os.path.ismount("/content/drive") else "DRIVE_ABSENT")' \
       | colab exec -s "$S" | grep -q DRIVE_MOUNTED; then
    echo "[up] Drive already mounted"
  elif [ -t 0 ] && [ -t 1 ]; then
    echo "[up] mounting Drive: approve the Google prompt if one opens (waits up to 10 minutes)"
    colab drivemount -s "$S" /content/drive
  else
    echo "[up] Drive is not mounted and this is not a terminal. Run:  colab drivemount -s $S   then re-run this script." >&2
    exit 2
  fi
fi

echo "[up] installing packages on the VM"
colab install -s "$S" unsloth
colab install -s "$S" -r backend/requirements.txt

echo "[up] sending the router and its settings"
echo 'import os; os.makedirs("/content/cloud-ai/backend", exist_ok=True)' | colab exec -s "$S"
for f in server.py unsloth_engine.py colab_start.py; do
  colab upload -s "$S" "backend/$f" "/content/cloud-ai/backend/$f" >/dev/null
done
T="$(mktemp)"; trap 'rm -f "$T"' EXIT; chmod 600 "$T"
{ echo "CLOUD_BACKEND=unsloth"; echo "CLOUD_UNSLOTH_MODEL=$MODEL"
  env | grep -E '^(CLOUD_(UNSLOTH_|TOKEN|TEMPERATURE|THINK|MAX_NEW_TOKENS|VISION_MODEL|FALLBACK_)|HF_TOKEN=)' \
      | grep -v '^CLOUD_UNSLOTH_MODEL=' || true; } > "$T"
colab upload -s "$S" "$T" /content/.cloud_env >/dev/null

echo "[up] starting the router and the tunnel"
colab exec -s "$S" -f backend/colab_start.py

H="${XDG_CONFIG_HOME:-$HOME/.config}/colab-cli/history"
colab log -s "$S" -o "$H/$S.ipynb" >/dev/null 2>&1 && chmod 600 "$H/$S.ipynb" && echo "[up] session notebook: $H/$S.ipynb" || true
echo "[up] history: $H/$S.jsonl   ·   stop with: colab stop -s $S"
