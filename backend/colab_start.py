"""Start the Cloud AI router (Unsloth backend) and a Cloudflare quick tunnel on a Colab VM.

Run on the VM, from a notebook cell (`%run /content/cloud-ai/backend/colab_start.py`)
or from your laptop with the Colab CLI (`backend/colab_up.sh`, which does
`colab exec -f backend/colab_start.py`).

It only launches detached processes and polls, printing a line every second,
because non-interactive `colab exec` gives up on a kernel that stays silent.
The model itself loads inside the router; /health reports "loading" until it is ready.

Settings come from the environment, then from /content/.cloud_env (KEY=VALUE lines).

Tunnel: a Cloudflare quick tunnel by default (new URL on every start). For a fixed
hostname set CLOUDFLARE_TUNNEL_TOKEN (a named tunnel whose public hostname points at
http://127.0.0.1:<CLOUD_PORT>) and CLOUD_PUBLIC_URL (that hostname, with https://).

Token: written to /content/.cloud_token (mode 0600) and not printed, so it stays out of
the Colab CLI's session history. Set CLOUD_PRINT_TOKEN=1 to print it (the notebook does).
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
named = env.get("CLOUDFLARE_TUNNEL_TOKEN", "")
if named and not env.get("CLOUD_PUBLIC_URL"):
    raise SystemExit("CLOUDFLARE_TUNNEL_TOKEN is set: also set CLOUD_PUBLIC_URL to the tunnel's hostname (https://...)")
if named:
    # The token goes through the environment (TUNNEL_TOKEN), not argv, so `ps` does not show it.
    env["TUNNEL_TOKEN"] = named
    detached([cf, "tunnel", "--no-autoupdate", "run"], "/tmp/cloudflared.log")
else:
    detached([cf, "tunnel", "--url", f"http://127.0.0.1:{port}", "--no-autoupdate"], "/tmp/cloudflared.log")
url = None
for i in range(60):
    log = open("/tmp/cloudflared.log").read()
    if named and "Registered tunnel connection" in log:
        url = env["CLOUD_PUBLIC_URL"].rstrip("/")
        break
    m = None if named else re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", log)
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
fd = os.open("/content/.cloud_token", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, env["CLOUD_TOKEN"].encode())
os.close(fd)
if env.get("CLOUD_PRINT_TOKEN", "").lower() in ("1", "true", "on"):
    print("CLOUD_TOKEN=" + env["CLOUD_TOKEN"])
else:
    print("CLOUD_TOKEN is in /content/.cloud_token on the VM (not printed)")
print("=" * 64)
print(f"backend=unsloth model={model}  (first load takes a few minutes; watch /health or /tmp/cloud.log)")
print("VS Code -> Settings -> Cloud AI -> paste Tunnel Url and Token.")
