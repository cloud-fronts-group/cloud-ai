"""Start the Cloud AI router (Unsloth backend) and a Cloudflare quick tunnel on a Colab VM.

Run on the VM, from a notebook cell (`%run /content/cloud-ai/backend/colab_start.py`)
or from your laptop with the Colab CLI (`backend/colab_up.sh`, which does
`colab exec -f backend/colab_start.py`).

It only launches detached processes and polls, printing a line every second,
because non-interactive `colab exec` gives up on a kernel that stays silent.
The model itself loads inside the router; /health reports "loading" until it is ready.

Settings come from the environment, then from /content/.cloud_env (KEY=VALUE lines).
"""
import os
import re
import secrets
import subprocess
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(globals().get("__file__", "/content/cloud-ai/backend/colab_start.py")))
if not os.path.exists(os.path.join(HERE, "server.py")):
    HERE = "/content/cloud-ai/backend"

if os.path.exists("/content/.cloud_env"):
    for line in open("/content/.cloud_env"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            if v.strip():
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

env = os.environ
env.setdefault("CLOUD_BACKEND", "unsloth")
env.setdefault("CLOUD_UNSLOTH_MODEL", "unsloth/Qwen3-4B-Instruct-2507")
env.setdefault("CLOUD_TOKEN", secrets.token_urlsafe(24))
env["CLOUD_HOST"], port = "127.0.0.1", env.setdefault("CLOUD_PORT", "7654")

model = env["CLOUD_UNSLOTH_MODEL"]
if model.startswith("/content/drive") and not os.path.ismount("/content/drive"):
    raise SystemExit(
        f"{model} is on Google Drive but /content/drive is not mounted.\n"
        "From a laptop: colab drivemount -s <session>   (the CLI answers Colab's credential request)\n"
        "In a notebook: from google.colab import drive; drive.mount('/content/drive')"
    )
if model.startswith("/") and not os.path.isdir(model):
    raise SystemExit(f"model folder not found: {model}")


def detached(cmd, log):
    return subprocess.Popen(cmd, stdout=open(log, "w"), stderr=subprocess.STDOUT, start_new_session=True, env=dict(env))


def health():
    req = urllib.request.Request(f"http://127.0.0.1:{port}/health", headers={"Authorization": "Bearer " + env["CLOUD_TOKEN"]})
    return urllib.request.urlopen(req, timeout=2).read().decode()


subprocess.run(["pkill", "-f", "backend/server.py"], check=False)
subprocess.run(["pkill", "-f", "cloudflared tunnel"], check=False)
detached(["python", os.path.join(HERE, "server.py")], "/tmp/cloud.log")
for i in range(60):
    try:
        print("[cloud] router up:", health(), flush=True)
        break
    except Exception:
        print(f"[cloud] waiting for the router ({i + 1}s)", flush=True)
        time.sleep(1)
else:
    raise SystemExit("router did not start:\n" + open("/tmp/cloud.log").read()[-3000:])

cf = "/usr/local/bin/cloudflared"
if not os.path.exists(cf):
    print("[cloud] downloading cloudflared", flush=True)
    urllib.request.urlretrieve(
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64", cf)
    os.chmod(cf, 0o755)
detached([cf, "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"], "/tmp/cloudflared.log")
url = None
for i in range(60):
    m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", open("/tmp/cloudflared.log").read())
    if m:
        url = m.group(0)
        break
    print(f"[cloud] waiting for the tunnel ({i + 1}s)", flush=True)
    time.sleep(1)
if not url:
    raise SystemExit("tunnel did not come up:\n" + open("/tmp/cloudflared.log").read()[-3000:])

env["CLOUD_URL"] = url
print("=" * 64)
print("CLOUD_URL=" + url)
print("CLOUD_TOKEN=" + env["CLOUD_TOKEN"])
print("=" * 64)
print(f"backend=unsloth model={model}  (first load takes a few minutes; watch /health or /tmp/cloud.log)")
print("VS Code -> Settings -> Cloud AI -> paste Tunnel Url and Token.")
