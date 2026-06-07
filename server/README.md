# CoVault — server setup

> 🌐 **한국어**: [`README.ko.md`](README.ko.md)

Setting up the servers is the biggest hurdle for new users, so this guide is deliberately step-by-step. If you can
copy-paste a few commands (or click through a NAS UI), you can do this. **You only set this up once.**

CoVault needs **two independent servers**:

- **CouchDB** — the central database for file sync. **Required.**
- **Yjs WebSocket server** — for realtime character-level co-editing. **Optional** — set it up later, only if you want
  realtime. File sync works completely without it.

They **never talk to each other** (the plugin is the only client of both), so you can run them on the same machine or
on entirely different providers. This folder documents both and ships the Yjs server's runtime files under
[`yjs/`](yjs/).

---

## Before you start

**You will need:**
- A place to run the servers (a NAS, a cloud server, or a spare always-on PC).
- For the recommended cloud path: a **domain name** (or a free dynamic-DNS hostname) and the ability to open ports
  80/443 — needed so HTTPS certificates can be issued. (No domain / can't open ports? Use a **tunnel** — see
  [Exposing it over HTTPS/WSS](#exposing-it-over-httpswss).)
- About **30–45 minutes** the first time.

**Why HTTPS is mandatory:** Obsidian on mobile only connects to `https://` (and `wss://`) endpoints. A plain
`http://192.168.x.x` address works on a desktop on the same LAN but **will not work on phones or off your network**, so
every path below ends with a real certificate.

**Pick your path:**

| Your situation | Recommended path |
|---|---|
| You already have a Synology / QNAP NAS | **NAS + reverse proxy** → [Walkthrough B](#walkthrough-b--couchdb-on-a-synology-nas) |
| No NAS; you want reliable remote access | **Cloud VPS + Caddy** → [Walkthrough A](#walkthrough-a--couchdb-on-a-cloud-vps-recommended) |
| Behind CGNAT / can't open router ports | Any host + **Cloudflare Tunnel** → [Exposing](#exposing-it-over-httpswss) |
| Want the least setup, OK with a monthly cost | **Managed/PaaS** → [Hosting options](#couchdb-hosting-options) (Cloudant / Railway) |

---

## Architecture & constraints

The plugin talks to two independent endpoints and is the only thing that bridges them:

```
            ┌──────────────── CouchDB   (PouchDB HTTP/HTTPS replication)
plugin      │
(manager/   ├──────────────── Yjs server (WebSocket / WSS)
 members)  │
            └─ realtime snapshots are written by the plugin → CouchDB
```

- **The Yjs server never connects to CouchDB.** It only uses `ws`/`y-websocket` + HMAC and persists locally to LevelDB.
  Realtime edits reach CouchDB only because the *plugin* periodically snapshots the live doc back through the sync
  layer — not via any server-to-server link.
- So **CouchDB and the Yjs server have no co-location requirement**: different hosts, providers, or regions are fine.
  Bundling them on one box is purely an operational convenience (one machine, one reverse proxy).
- The hard constraints are **reachability** (every client must reach both over the internet — neither can sit on a
  LAN-only address if remote members need it), **HTTPS/WSS** (mobile requires secure transport), and **`YJS_SECRET`
  parity** between the Yjs server and the plugin setting.

---

# CouchDB (required)

Follow **one** of the two walkthroughs below, then jump to [Yjs](#yjs-realtime-server-optional) only if you want
realtime. The [hosting options](#couchdb-hosting-options) section afterwards explains every alternative in detail.

## Walkthrough A — CouchDB on a cloud VPS (recommended)

The cleanest path if you don't have a NAS. Example: a fresh Ubuntu 22.04/24.04 server (Hetzner, DigitalOcean, Vultr,
Lightsail, Oracle Cloud…). The smallest tier (1 vCPU / 1 GB) is plenty.

**1. Point a domain at the server.** Create a DNS **A record** like `couch.example.com` → your server's public IP.
(For realtime later, also add `yjs.example.com` → the same IP.) Open inbound ports **80 and 443** in the provider's
firewall.

**2. Install Docker.**
```bash
curl -fsSL https://get.docker.com | sh
```

**3. Run CouchDB with persistent storage**, bound to localhost (the proxy will expose it over HTTPS):
```bash
mkdir -p ~/couchdb && cd ~/couchdb
cat > docker-compose.yml <<'YAML'
services:
  couchdb:
    image: couchdb:3
    restart: unless-stopped
    environment:
      - COUCHDB_USER=admin
      - COUCHDB_PASSWORD=PUT_A_STRONG_PASSWORD_HERE
    volumes:
      - ./data:/opt/couchdb/data        # persistent — survives restarts/upgrades
    ports:
      - "127.0.0.1:5984:5984"           # localhost only; never expose 5984 publicly
YAML
docker compose up -d
```

**4. Initialize the system databases** (`_users`, `_replicator`, …) — required once on a fresh install:
```bash
curl -X POST http://admin:PUT_A_STRONG_PASSWORD_HERE@127.0.0.1:5984/_cluster_setup \
  -H 'Content-Type: application/json' \
  -d '{"action":"enable_single_node","bind_address":"0.0.0.0","singlenode":true,
       "username":"admin","password":"PUT_A_STRONG_PASSWORD_HERE","port":5984}'
```
Verify: `curl http://admin:...@127.0.0.1:5984/_up` should return `{"status":"ok"}`.

**5. Put HTTPS in front with Caddy** (auto-issues and renews Let's Encrypt certificates):
```bash
# Install Caddy — full instructions: https://caddyserver.com/docs/install
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```
Edit `/etc/caddy/Caddyfile` so it contains just:
```caddyfile
couch.example.com {
    reverse_proxy localhost:5984
}
```
Then `sudo systemctl reload caddy`. Within a minute Caddy fetches a certificate.

**6. Test from anywhere:** open `https://couch.example.com/_up` in a browser → `{"status":"ok"}`. Done — use
`https://couch.example.com` as the **CouchDB URL** in the plugin (Manager Mode), with `admin` / your password.

> The plugin creates all member accounts, databases, and permissions for you. You do **not** create any databases by
> hand — just hand it the URL and admin credentials.

## Walkthrough B — CouchDB on a Synology NAS

DSM 7.2+ with **Container Manager** (older DSM: "Docker"). All clicking, no terminal required.

**1. Download the image.** Container Manager → **Registry** → search `couchdb` → download, tag `3` (or `latest`).

**2. Create the container.** Container Manager → **Container** → **Create** → image `couchdb:latest` → Next, and in the
settings (the sections match the DSM UI order):
- **Enable auto-restart.**
- **Port Settings:** map local **5984** → container **5984**.
- **Volume Settings:** add a folder, e.g. `docker/couchdb/data` on the NAS, and mount it to **`/opt/couchdb/data`**.
- **Environment:** add the variables `COUCHDB_USER=admin` and `COUCHDB_PASSWORD=<a strong password>`.

Start the container.

**3. Initialize system databases.** Open `http://<nas-lan-ip>:5984/_utils` (Fauxton) in a browser, log in as admin →
**Setup** → it will offer to set up a single node, or run the same `curl … /_cluster_setup …` from Walkthrough A step 4
against `http://<nas-lan-ip>:5984`.

**4. Get a hostname + certificate.**
- **DDNS:** Control Panel → External Access → **DDNS** → add a `*.synology.me` hostname (free).
- **Certificate:** Control Panel → Security → **Certificate** → add a **Let's Encrypt** cert for that hostname.

**5. Reverse proxy (adds HTTPS).** Control Panel → Login Portal → **Advanced** → **Reverse Proxy** → Create:
- **Source:** protocol HTTPS, hostname `couch.yourname.synology.me`, port `443`.
- **Destination:** protocol HTTP, hostname `localhost`, port `5984`.

**6. Test:** `https://couch.yourname.synology.me/_up` → `{"status":"ok"}`. Use that URL + admin credentials in the
plugin.

> For the Yjs realtime server later, you'll add a **second** reverse-proxy entry — and there you must also enable the
> **WebSocket** custom header (see [Synology + WebSocket](#exposing-it-over-httpswss)).

## What every CouchDB host needs

Whichever route you take, the same four essentials apply:

- **Persistent storage** mounted at `/opt/couchdb/data` — always a real volume/folder, never an ephemeral container
  layer, or member data is lost on redeploy. A organization is small; a few GB is usually enough (size up if you sync
  many large attachments).
- **HTTPS in front.** Obsidian mobile only connects over `https://`. Use a reverse proxy with a Let's Encrypt
  certificate, or a platform that provides TLS automatically.
- **A strong admin password,** used by the plugin **only on the manager's device** to provision members. Members get
  their own least-privilege accounts — never share admin credentials with them.
- **Modest specs.** Single-node CouchDB is light — **1 vCPU / 1 GB RAM** comfortably handles a workspace; no clustering
  needed. The official `couchdb:3` image is multi-arch (x86-64 **and** arm64 / Raspberry Pi).

## CouchDB hosting options

CouchDB is standard software — the plugin only needs an HTTPS URL + admin account. Detailed comparison:

**① Your own hardware (NAS / Raspberry Pi / mini-PC / home server)**
- *Good for:* you already own always-on hardware, want **zero monthly cost** and full data ownership.
- *Setup:* run `couchdb:3` via Docker (NAS UI / Portainer / CLI), mount a volume at `/opt/couchdb/data`, set
  `COUCHDB_USER` / `COUCHDB_PASSWORD` (see Walkthrough B).
- *Exposure:* home networks rarely have a static public IP or open inbound ports. Use the NAS reverse proxy + DDNS +
  Let's Encrypt, **or** a tunnel (Cloudflare Tunnel / Tailscale).
- *Caveats:* many ISPs use **CGNAT** or block ports 80/443, so inbound port-forwarding won't work → use a tunnel.
  Schedule **backups of the data folder.** Uptime depends on your power and internet.

**② Cloud VPS + Docker (Hetzner, DigitalOcean, Vultr, Linode, AWS Lightsail, Oracle Cloud Always-Free)**
- *Good for:* remote members, no static home IP, or you just want a reliable public IP, and don't mind a Linux box.
- *Setup:* see Walkthrough A — smallest tier (1 vCPU / 1–2 GB), Docker + a localhost-bound CouchDB + Caddy for HTTPS.
- *Cost:* a small VPS ≈ a few USD/month (Hetzner is cheapest); **Oracle Cloud Always-Free** can be $0 on an ARM Ampere
  instance (signup quotas/availability vary by region).
- *Caveats:* you own OS patching, firewall, and backups. **Keep `5984` bound to localhost / the Docker network and only
  expose 443** through the proxy — never publish CouchDB's port to the internet. Enable automatic security updates.

**③ PaaS / one-click container (Railway, Render, Fly.io)**
- *Good for:* you don't want to manage a server OS; HTTPS and a domain come automatically.
- *Setup:* deploy the official `couchdb:3` image, **attach a persistent volume/disk** at `/opt/couchdb/data`, set
  `COUCHDB_USER` / `COUCHDB_PASSWORD`. The platform gives you an `https://…` URL for the plugin.
- *Caveats:* **free tiers sleep and may not persist data** — use a paid plan with a real attached volume for anything
  real. Confirm the container stays always-on and exposes the HTTP port. Storage/egress is billed.

**④ Managed CouchDB (IBM Cloudant)**
- *Good for:* zero server management; you accept a SaaS and its pricing.
- *Setup:* create a Cloudant instance, use its HTTPS endpoint + generated credentials as the plugin's admin URL.
- *Caveats:* Cloudant is CouchDB-compatible but **not identical** — request-rate-based pricing (the lite plan caps
  throughput), and an IAM/API-key auth model that differs from a self-hosted `_users` database. The plugin's
  auto-provisioning (creating `_users` accounts + per-DB `_security`) targets standard CouchDB, so **test
  invite/provisioning on a trial instance first.** Data residency follows the IBM region you pick.

---

# Yjs realtime server (optional)

Only for **realtime co-editing** — independent of CouchDB file sync; **skip this entirely if you only need file sync.**
Set it up *after* CouchDB is working. The runtime files live in [`yjs/`](yjs/):

- [`yjs/server.js`](yjs/server.js) — y-websocket server using **per-space HMAC `YJS_SECRET`** auth. (A legacy global
  `YJS_TOKEN` mode still exists in the code but is **deprecated** — the current plugin issues per-space HMAC tokens only;
  set `YJS_SECRET`.)
- [`yjs/Dockerfile`](yjs/Dockerfile) / [`yjs/docker-compose.yml`](yjs/docker-compose.yml) /
  [`yjs/package.json`](yjs/package.json) — container build + run (LevelDB persistence in `./data`).
- [`yjs/disable-yjs-accesslog.sh`](yjs/disable-yjs-accesslog.sh) — Synology DSM helper to keep `?token=` out of
  reverse-proxy access logs.

## Walkthrough — Yjs on the same host as CouchDB

**1. Get the files onto the server** (clone the repo, or copy the `server/yjs/` folder):
```bash
git clone https://github.com/wakeyi-git/obsidian-covault.git
cd obsidian-covault/server/yjs
```

**2. Set a secret and start it.** Generate a long random `YJS_SECRET` (this is the HMAC key; you'll paste the same
value into the plugin):
```bash
echo "YJS_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d --build
docker compose logs -f          # startup line should read: auth: hmac (per-space)
```
Sanity check on the LAN: `http://<host>:1234` → `Yjs WebSocket server OK`. (The server refuses to start if
`YJS_SECRET` is a placeholder like `CHANGE_ME` or shorter than 16 chars — that's intentional.)

**3. Expose it over `wss://`.** Add a second reverse-proxy route for `yjs.example.com` → `localhost:1234`:
- **Caddy:** add a block to your Caddyfile and reload (WebSockets work automatically):
  ```caddyfile
  yjs.example.com {
      reverse_proxy localhost:1234
      log { output discard }      # keep ?token= out of access logs
  }
  ```
- **Synology:** create a second Reverse Proxy entry (`yjs.yourname.synology.me` → `localhost:1234`) **and** enable the
  WebSocket header — see [Synology + WebSocket](#exposing-it-over-httpswss).

**4. Configure the plugin.** Settings → **Yjs server URL** = `wss://yjs.example.com`, **Yjs space secret (HMAC)** = the
exact `YJS_SECRET` value. Enable realtime, then **deploy** a shared space — per-space signed tokens are issued to
members automatically.

## Make it safe (required for real use)

1. **Never expose port 1234 directly.** Always behind an **HTTPS reverse proxy (`wss://`)**, forwarding the WebSocket
   `Upgrade`/`Connection` headers.
2. **`YJS_SECRET` parity.** The server env var and the plugin's *Yjs space secret (HMAC)* must be the **same value**. A
   leaked per-space token then only grants that one space's room (the server checks the room starts with
   `<workspaceId>/share/<spaceId>/`).
3. **Keep tokens out of logs.** The token rides as a `?token=` query, so mask/disable query logging on the proxy / CDN /
   monitoring (Synology DSM: [`yjs/disable-yjs-accesslog.sh`](yjs/disable-yjs-accesslog.sh); Caddy: `log { output
   discard }`; nginx: `access_log off` or a `$args`-stripping format). Tokens travel over WSS so they aren't exposed in
   transit — the risk is plaintext tokens piling up in logs.

## What every Yjs host needs

This is **your own server (`yjs/`)**, not a generic Yjs service. Wherever you run it:

- **An always-on, long-lived process.** WebSocket sessions are persistent; a platform that scales the instance to zero
  when idle will drop live co-editing. Pick an always-on instance.
- **A persistent volume for LevelDB** (`/data` in the container) so a restart doesn't lose un-snapshotted state. (The
  authoritative copy still lands in CouchDB via the plugin's snapshots; the LevelDB cache just smooths restarts.)
- **WSS termination + WebSocket pass-through** — the proxy must forward `Upgrade`/`Connection` and allow long-lived
  connections (raise read timeouts).
- **Tiny specs.** y-websocket keeps active docs in memory; **1 vCPU / 512 MB–1 GB** is plenty for a organization.

## Yjs hosting options

**① Same box as CouchDB** — *simplest to operate.* One machine, one reverse proxy with two routes (a `couch.`
subdomain → `5984`, a `yjs.` subdomain → `1234`). Realtime traffic is bursty WebSocket while CouchDB is plain HTTP; at
organization load they coexist comfortably on a 1–2 GB box.

**② Cloud VPS / home server (separate from CouchDB)** — same steps as the walkthrough, on its own host. A
512 MB–1 GB instance is enough. Good when you want realtime isolated from file sync, or in a region closer to members.

**③ PaaS (Railway / Render / Fly.io)** — deploy the `yjs/` image with a **persistent volume** for `/data`. Confirm the
plan is **always-on (no scale-to-zero)** and passes WebSockets through; otherwise idle sessions get dropped. TLS and a
domain are automatic.

**④ ⚠️ Managed Yjs SaaS (PartyKit, Liveblocks, Hocuspocus Cloud, y-sweet) — not a drop-in.** These don't implement this
server's per-space HMAC `?token=` verification or the `<workspaceId>/share/<spaceId>/` room check, so the plugin's
space-isolation security model wouldn't apply (a token would grant more than intended). Stick to running this server —
porting the auth scheme onto another backend is possible but it's manual work, not configuration.

---

## Exposing it over HTTPS/WSS

How to put a real certificate in front of either server. **All of these work for CouchDB too** — just point at port
`5984` instead of `1234`.

**Caddy** — point a domain at it and HTTPS is auto-issued/renewed; WebSockets work out of the box. A complete site:
```caddyfile
yjs.example.com {
    reverse_proxy localhost:1234
    log { output discard }          # keep ?token= out of access logs
}
```
Requirements: the domain's A record points at the server, and ports 80/443 are open (Caddy needs 80 for the ACME
challenge).

**nginx** — needs explicit WebSocket upgrade headers and a long read timeout (without these, realtime silently fails to
connect):
```nginx
location / {
    proxy_pass http://127.0.0.1:1234;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_read_timeout 3600s;        # keep long-lived WS connections open
    access_log off;                  # or a log_format that strips $args (the ?token=)
}
```

**Synology + WebSocket** — DSM's Reverse Proxy does **not** pass WebSockets by default. After creating the entry, open
it → **Custom Header** → **Create** → **WebSocket** (this inserts the `Upgrade`/`Connection` headers). Without this,
CouchDB sync works but **realtime won't connect**.

**Cloudflare Tunnel** — run `cloudflared` next to the server to map a public hostname → `localhost:1234` **without
port-forwarding or a static IP**; TLS terminates at Cloudflare's edge and WebSockets are supported. Ideal behind CGNAT.
Keep query strings out of edge logging/analytics so `?token=` isn't retained.

**Tailscale Funnel** — publicly expose a tailnet node over TLS via its `*.ts.net` hostname, again with no
port-forwarding. Note Funnel only serves a fixed set of ports (443 / 8443 / 10000) and has bandwidth limits — fine for
a workspace, not heavy public traffic.

**Traefik** — container auto-discovery + Let's Encrypt; convenient when you run several services and prefer routing by
labels over hand-written vhosts.

---

## Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| **Works on desktop (LAN), fails on phone / off-network** | You used `http://` or a LAN IP. Mobile needs a real `https://` domain + certificate — finish the reverse-proxy step. |
| **`Connection refused` / can't reach the URL** | Container not running (`docker compose ps`), wrong port, or the firewall doesn't allow 443. CouchDB must be reachable from the proxy on `5984`. |
| **`401 Unauthorized`** | Wrong admin user/password, or the URL is missing. Re-check the plugin's CouchDB URL + admin credentials. |
| **CouchDB returns 500 / "system databases" errors** | You skipped the single-node init — run the `/_cluster_setup` step (Walkthrough A step 4). |
| **Certificate invalid / not issued** | DNS A record not pointing at the server yet (propagation), or port 80 closed (Caddy/Let's Encrypt need it for the ACME challenge). |
| **File sync works, realtime won't connect** | The proxy isn't passing WebSockets. Add the `Upgrade`/`Connection` headers (nginx) or the **WebSocket custom header** (Synology); confirm the URL is `wss://`. |
| **Yjs container won't start** | `YJS_SECRET` is a placeholder/too short. Set a real 32-byte hex value (`openssl rand -hex 32`). Check `docker compose logs`. |
| **Realtime token rejected** | The plugin's *Yjs space secret* ≠ the server's `YJS_SECRET`. Make them identical, then **redeploy** the space to re-issue tokens. |
| **Excalidraw realtime not working** | Install the Excalidraw plugin and use the `.excalidraw.md` format (plain `.excalidraw` is unsupported). |

---

## Security checklist

Before a real organization:

- [ ] CouchDB is **only** reachable over HTTPS; the raw `5984` port is not published to the internet.
- [ ] The admin password is strong and lives **only on the manager's device** — members never receive it.
- [ ] `YJS_SECRET` is a fresh random value (not the placeholder), identical on the server and in the plugin.
- [ ] The reverse proxy/CDN **does not log `?token=`** query strings.
- [ ] The CouchDB **data volume is backed up** on a schedule.
- [ ] Secrets/tokens are never committed to a repository — the plugin keeps them in Obsidian Secret Storage and excludes
      them from settings export; keep your server's real secret only on the server.
