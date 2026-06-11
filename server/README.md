# CoVault — server setup

> 🌐 **한국어**: [`README.ko.md`](README.ko.md)

Setting up the servers is the biggest hurdle for new users, so this guide is deliberately step-by-step. If you can
copy-paste a few commands (or click through a NAS UI), you can do this. **You only set this up once.**

CoVault needs **two independent servers**:

- **CouchDB** — the central database for file sync. **Required.**
- **Realtime server (Hocuspocus)** — for realtime character-level co-editing. **Optional** — set it up later, only if
  you want realtime. File sync works completely without it.

The realtime server is also a CouchDB client (it reads per-file authorization docs and stores document snapshots). You
can run them on the same machine or on different providers — the realtime server just needs to reach the CouchDB URL.
This folder documents both and ships the realtime server's runtime files under [`hocuspocus/`](hocuspocus/).

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

The plugin talks to two independent endpoints; the realtime server is also a CouchDB client:

```
            ┌──────────────── CouchDB   (PouchDB HTTP/HTTPS replication)
plugin      │                     ▲
(manager/   ├──────────────── realtime server (Hocuspocus, WebSocket/WSS)
 members)  │                     └─ per-file authorization lookups (rtpart/rtcontrol) + note snapshots
```

- **The realtime server connects to CouchDB** (a dedicated service account is recommended). It reads per-file
  participant docs (rtpart) to enforce room entry server-side, and stores edits back to CouchDB note docs on a
  debounce — the client-side single-writer election and periodic snapshots are gone. The Yjs state itself is
  persisted locally to SQLite (`/data`).
- **CouchDB and the realtime server have no co-location requirement** — the realtime server just needs to reach
  `COUCHDB_URL`. Bundling them on one box is the simplest operationally (one machine, one reverse proxy).
- The hard constraints are **reachability** (every client must reach both over the internet — neither can sit on a
  LAN-only address if remote members need it), **HTTPS/WSS** (mobile requires secure transport), **`YJS_SECRET`
  parity** between the realtime server and the plugin setting, and a **CouchDB service account**
  (`COUCHDB_USER`/`COUCHDB_PASSWORD`) for the realtime server.

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

# Realtime server — Hocuspocus (optional)

Only for **realtime co-editing** — **skip this entirely if you only need file sync.** Set it up *after* CouchDB is
working (the realtime server connects to CouchDB for authorization lookups and snapshots). The runtime files live in
[`hocuspocus/`](hocuspocus/):

- [`hocuspocus/server.js`](hocuspocus/server.js) — Hocuspocus v4 server: **per-member HMAC tokens** (`YJS_SECRET`) +
  CouchDB-backed **per-file authorization** (rtpart docs; removed participants are kicked live) + **server-side
  seeding/snapshots** (onLoadDocument/onStoreDocument).
- [`hocuspocus/auth.js`](hocuspocus/auth.js) / [`hocuspocus/couch.js`](hocuspocus/couch.js) — token verification and
  the CouchDB client.
- [`hocuspocus/Dockerfile`](hocuspocus/Dockerfile) / [`hocuspocus/docker-compose.yml`](hocuspocus/docker-compose.yml) /
  [`hocuspocus/package.json`](hocuspocus/package.json) — container build + run (Yjs state persisted to a single SQLite
  file in `./data`).

> Tokens are sent in an **authentication message** after the WebSocket is established (not as a URL query) — the
> reverse-proxy access-log masking the old y-websocket server needed (`disable-yjs-accesslog.sh`) is gone.

## Walkthrough — realtime server on the same host as CouchDB

**1. Get the files onto the server** (clone the repo, or copy the `server/hocuspocus/` folder):
```bash
git clone https://github.com/wakeyi-git/obsidian-covault.git
cd obsidian-covault/server/hocuspocus
```

**2. Configure and start it.** Generate a long random `YJS_SECRET` (the HMAC key; you'll paste the same value into the
plugin) and fill in the CouchDB connection in `docker-compose.yml`:
```bash
openssl rand -hex 32            # → use as YJS_SECRET
# docker-compose.yml: set YJS_SECRET / COUCHDB_URL / COUCHDB_USER / COUCHDB_PASSWORD
docker compose up -d --build
docker compose logs -f          # startup should read: auth: hmac per-member (file-level: on (CouchDB))
```
Sanity check on the LAN: `http://<host>:1234` → `CoVault realtime server OK`. (The server refuses to start if
`YJS_SECRET` is missing, a placeholder like `CHANGE_ME`, or shorter than 16 chars — that's intentional.)

Keep `COUCHDB_USER` identical to the plugin's **Realtime server account** setting (recommended `covault-rt`) — on
deploy the plugin creates the account and grants it access to the share/mirror DBs, so the server never needs the
CouchDB admin password.

**3. Expose it over `wss://`.** Add a second reverse-proxy route for `rt.example.com` → `localhost:1234`:
- **Caddy:** add a block to your Caddyfile and reload (WebSockets work automatically):
  ```caddyfile
  rt.example.com {
      reverse_proxy localhost:1234
  }
  ```
- **Synology:** create a second Reverse Proxy entry (`rt.yourname.synology.me` → `localhost:1234`) **and** enable the
  WebSocket header — see [Synology + WebSocket](#exposing-it-over-httpswss).

**4. Configure the plugin.** Settings → **Yjs server URL** = `wss://rt.example.com`, **Yjs space secret (HMAC)** = the
exact `YJS_SECRET` value, **Realtime server account/password** = the same `COUCHDB_USER`/`COUCHDB_PASSWORD`. Enable
realtime, then **deploy** a shared space — per-member signed tokens are issued to members automatically and the
service account is granted DB access.

## Make it safe (required for real use)

1. **Never expose port 1234 directly.** Always behind an **HTTPS reverse proxy (`wss://`)**, forwarding the WebSocket
   `Upgrade`/`Connection` headers.
2. **`YJS_SECRET` parity.** The server env var and the plugin's *Yjs space secret (HMAC)* must be the **same value**.
   Tokens are signed with per-member claims (space, DB, member, role), so a leaked token only grants that one space
   with that one member's permissions (the server checks the room prefix and per-file participants).
3. **Use a dedicated CouchDB service account.** An admin account works, but if the realtime server is compromised the
   whole CouchDB is exposed — the account created via the plugin's *Realtime server account* setting can only reach
   the share/mirror DBs.

## What every realtime-server host needs

This is **your own server (`hocuspocus/`)**, not a generic Yjs service. Wherever you run it:

- **An always-on, long-lived process.** WebSocket sessions are persistent; a platform that scales the instance to zero
  when idle will drop live co-editing. Pick an always-on instance.
- **A persistent volume for SQLite** (`/data` in the container) so a restart doesn't lose live-session state. (The
  authoritative markdown copy still lands in CouchDB via the server's snapshots; SQLite smooths restarts/rejoins.)
- **CouchDB reachability** — per-file authorization, seeding, and snapshots all need `COUCHDB_URL` to be reachable
  from the server.
- **WSS termination + WebSocket pass-through** — the proxy must forward `Upgrade`/`Connection` and allow long-lived
  connections (raise read timeouts).
- **Tiny specs.** Only active docs stay in memory (idle docs are unloaded); **1 vCPU / 512 MB–1 GB** is plenty for an
  organization.

## Realtime server hosting options

**① Same box as CouchDB** — *simplest to operate.* One machine, one reverse proxy with two routes (a `couch.`
subdomain → `5984`, an `rt.` subdomain → `1234`), and `COUCHDB_URL` points at the internal address.

**② Cloud VPS / home server (separate from CouchDB)** — same steps as the walkthrough, on its own host. A
512 MB–1 GB instance is enough. `COUCHDB_URL` becomes the public HTTPS address, so that hop is encrypted too.

**③ PaaS (Railway / Render / Fly.io)** — deploy the `hocuspocus/` image with a **persistent volume** for `/data`.
Confirm the plan is **always-on (no scale-to-zero)** and passes WebSockets through; otherwise idle sessions get
dropped. TLS and a domain are automatic.

**④ ⚠️ Managed Yjs SaaS (PartyKit, Liveblocks, Hocuspocus Cloud, y-sweet) — not a drop-in.** These don't implement
this server's per-member HMAC token verification, room-prefix checks, or the CouchDB-backed per-file
authorization/snapshots, so CoVault's security and storage model wouldn't apply. Stick to running this server.

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
Keeping query strings out of edge logging/analytics is optional defense-in-depth — CoVault sends realtime tokens in an authentication message, never in the URL.

**Tailscale Funnel** — publicly expose a tailnet node over TLS via its `*.ts.net` hostname, again with no
port-forwarding. Note Funnel only serves a fixed set of ports (443 / 8443 / 10000) and has bandwidth limits — fine for
a workspace, not heavy public traffic.

**Traefik** — container auto-discovery + Let's Encrypt; convenient when you run several services and prefer routing by
labels over hand-written vhosts.

---

## Scaling to dozens of members

A manager vault keeps **one live `_changes` longpoll per member DB** (plus one per shared space). With 30–40 members
that exceeds the HTTP/1.1 per-host connection limit (typically 6), so requests queue and sync lags. Two mitigations:

- Put CouchDB behind a reverse proxy that speaks **HTTP/2** to clients (Caddy and recent nginx do this automatically
  over HTTPS) — multiplexing removes the per-host connection cap.
- Or enable **Unified change detection** in the plugin's manager settings (experimental, v0.112+): one `_db_updates`
  connection watches every DB and only changed DBs replicate — requires server-admin credentials, falls back
  automatically when unsupported.
- On the manager device, prefer running large workspaces on the desktop app and keep mobile to member vaults
  (a member vault uses only 1–2 connections).

Startup also walks every file under each member folder once (hash check); on very large vaults give the first
sync after install a few minutes.

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
- [ ] (Defense-in-depth) The reverse proxy/CDN does not retain query strings in logs — CoVault never puts tokens in URLs, but other apps might.
- [ ] The CouchDB **data volume is backed up** on a schedule.
- [ ] Secrets/tokens are never committed to a repository — the plugin keeps them in Obsidian Secret Storage and excludes
      them from settings export; keep your server's real secret only on the server.
