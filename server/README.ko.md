# CoVault — 서버 구축

> 🌐 **English**: [`README.md`](README.md)

서버 구축은 새 사용자에게 가장 큰 진입 장벽이라, 이 가이드는 의도적으로 단계별로 작성했습니다. 명령 몇 줄을 복사해 붙여넣을 수
있거나(또는 NAS UI를 클릭할 수 있으면) 누구나 할 수 있습니다. **구축은 한 번만 하면 됩니다.**

CoVault는 **독립적인 두 서버**가 필요합니다:

- **CouchDB** — 파일 동기화를 위한 중앙 데이터베이스. **필수.**
- **Yjs WebSocket 서버** — 문자 단위 실시간 공동 편집용. **선택** — 실시간이 필요할 때 나중에 구축하면 됩니다. 파일
  동기화는 이 서버 없이도 완전히 동작합니다.

두 서버는 **서로 통신하지 않으며**(플러그인이 둘의 유일한 클라이언트), 같은 머신에 두거나 완전히 다른 제공자에 나눠 둘 수
있습니다. 이 폴더는 두 서버 모두를 설명하며, Yjs 서버의 구동 파일은 [`yjs/`](yjs/)에 들어 있습니다.

---

## 시작하기 전에

**필요한 것:**
- 서버를 돌릴 곳(NAS, 클라우드 서버, 또는 상시 켜진 여분의 PC).
- 권장 클라우드 경로의 경우: **도메인 이름**(또는 무료 동적 DNS 호스트명)과 포트 80/443을 열 수 있는 권한 — HTTPS
  인증서 발급에 필요합니다. (도메인이 없거나 포트를 못 열면? **터널**을 쓰세요 —
  [HTTPS/WSS로 노출하기](#httpswss로-노출하기) 참고.)
- 처음이라면 약 **30~45분**.

**HTTPS가 필수인 이유:** Obsidian 모바일은 `https://`(및 `wss://`) 엔드포인트에만 접속합니다. 평문 `http://192.168.x.x`
주소는 같은 LAN의 데스크톱에서는 되지만 **휴대폰이나 외부 네트워크에서는 안 됩니다.** 그래서 아래 모든 경로는 실제 인증서로
끝납니다.

**경로 고르기:**

| 상황 | 권장 경로 |
|---|---|
| 이미 시놀로지 / QNAP NAS가 있음 | **NAS + 리버스 프록시** → [따라하기 B](#따라하기-b-시놀로지-nas) |
| NAS 없음, 안정적인 원격 접근 필요 | **클라우드 VPS + Caddy** → [따라하기 A](#따라하기-a-클라우드-vps-권장) |
| CGNAT / 공유기 포트를 못 엶 | 아무 호스트 + **Cloudflare Tunnel** → [노출하기](#httpswss로-노출하기) |
| 설정 최소화, 월 비용 감수 | **관리형/PaaS** → [호스팅 선택지](#couchdb-호스팅-선택지) (Cloudant / Railway) |

---

## 구조와 제약

플러그인은 독립된 두 엔드포인트와 통신하며, 둘을 잇는 유일한 주체입니다:

```
            ┌──────────────── CouchDB    (PouchDB HTTP/HTTPS 복제)
플러그인     │
(운영자/      ├──────────────── Yjs 서버    (WebSocket / WSS)
 구성원)       │
            └─ 실시간 스냅샷은 플러그인이 → CouchDB에 기록
```

- **Yjs 서버는 CouchDB에 전혀 접속하지 않습니다.** `ws`/`y-websocket` + HMAC만 사용하고 LevelDB에 로컬로 영속
  저장합니다. 실시간 편집이 CouchDB에 반영되는 것은 *플러그인*이 라이브 문서를 주기적으로 스냅샷해 동기화 계층으로
  되돌려 쓰기 때문이며, 서버 간 직접 연결이 아닙니다.
- 따라서 **CouchDB와 Yjs 서버는 같은 위치에 있을 필요가 없습니다**: 서로 다른 호스트·제공자·리전이어도 무방합니다.
  한 서버에 함께 두는 것은 순전히 운영 편의(한 대의 머신, 하나의 리버스 프록시)일 뿐입니다.
- 하드 제약은 **도달성**(모든 클라이언트가 인터넷으로 둘 다에 닿을 수 있어야 함 — 원격 구성원이 있으면 어느 쪽도 LAN 전용
  주소에 둘 수 없음), **HTTPS/WSS**(모바일은 보안 전송 필수), 그리고 Yjs 서버와 플러그인 설정 간의
  **`YJS_SECRET` 일치**입니다.

---

# CouchDB (필수)

아래 두 따라하기 중 **하나**를 따른 뒤, 실시간이 필요하면 [Yjs](#yjs-실시간-서버-선택)로 넘어가세요. 뒤의
[호스팅 선택지](#couchdb-호스팅-선택지)에서 모든 대안을 상세히 설명합니다.

## 따라하기 A: 클라우드 VPS (권장)

NAS가 없을 때 가장 깔끔한 경로입니다. 예: 새로 만든 Ubuntu 22.04/24.04 서버(Hetzner, DigitalOcean, Vultr, Lightsail,
Oracle Cloud…). 가장 작은 티어(1 vCPU / 1 GB)면 충분합니다.

**1. 도메인을 서버로 연결.** `couch.example.com` → 서버의 공인 IP 같은 DNS **A 레코드**를 만듭니다. (나중에 실시간을
쓰려면 `yjs.example.com` → 같은 IP도 추가.) 제공자 방화벽에서 인바운드 **80, 443** 포트를 엽니다.

**2. Docker 설치.**
```bash
curl -fsSL https://get.docker.com | sh
```

**3. 영속 저장과 함께 CouchDB 실행** — localhost에만 바인딩(프록시가 HTTPS로 노출):
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
      - ./data:/opt/couchdb/data        # 영속 — 재시작/업그레이드에도 보존
    ports:
      - "127.0.0.1:5984:5984"           # localhost만; 5984를 외부에 공개 금지
YAML
docker compose up -d
```

**4. 시스템 데이터베이스 초기화**(`_users`, `_replicator` 등) — 새 설치에서 한 번 필요:
```bash
curl -X POST http://admin:PUT_A_STRONG_PASSWORD_HERE@127.0.0.1:5984/_cluster_setup \
  -H 'Content-Type: application/json' \
  -d '{"action":"enable_single_node","bind_address":"0.0.0.0","singlenode":true,
       "username":"admin","password":"PUT_A_STRONG_PASSWORD_HERE","port":5984}'
```
확인: `curl http://admin:...@127.0.0.1:5984/_up` → `{"status":"ok"}`.

**5. Caddy로 HTTPS 적용**(Let's Encrypt 인증서 자동 발급/갱신):
```bash
# Caddy 설치 — 전체 안내: https://caddyserver.com/docs/install
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```
`/etc/caddy/Caddyfile`을 다음 내용만 남도록 편집:
```caddyfile
couch.example.com {
    reverse_proxy localhost:5984
}
```
그리고 `sudo systemctl reload caddy`. 1분 내에 Caddy가 인증서를 받아옵니다.

**6. 어디서나 테스트:** 브라우저에서 `https://couch.example.com/_up` → `{"status":"ok"}`. 완료 — 플러그인(운영자 모드)의
**CouchDB URL**에 `https://couch.example.com`을, 계정은 `admin` / 비밀번호를 입력합니다.

> 플러그인이 모든 구성원 계정·데이터베이스·권한을 대신 생성합니다. 데이터베이스를 손수 만들 필요가 **없습니다** — URL과
> 관리자 자격증명만 넘기면 됩니다.

## 따라하기 B: 시놀로지 NAS

**Container Manager**가 있는 DSM 7.2 이상(이전 DSM은 "Docker"). 전부 클릭으로, 터미널 불필요.

**1. 이미지 다운로드.** Container Manager → **레지스트리** → `couchdb` 검색 → 다운로드, 태그 `3`(또는 `latest`).

**2. 컨테이너 생성.** Container Manager → **컨테이너** → **생성** → 이미지 `couchdb:3` → 다음, 설정에서:
- **자동 재시작 활성화.**
- **저장소/볼륨:** NAS에 폴더(예: `docker/couchdb`)를 추가하고 **`/opt/couchdb/data`** 에 마운트.
- **포트:** 로컬 **5984** → 컨테이너 **5984**.
- **환경변수:** `COUCHDB_USER=admin`, `COUCHDB_PASSWORD=<강력한 비밀번호>` 추가.

컨테이너를 시작합니다.

**3. 시스템 데이터베이스 초기화.** 브라우저에서 `http://<NAS-LAN-IP>:5984/_utils`(Fauxton)를 열고 admin으로 로그인 →
단일 노드 설정을 안내하거나, 따라하기 A 4단계의 `curl … /_cluster_setup …` 을 `http://<NAS-LAN-IP>:5984` 대상으로
실행합니다.

**4. 호스트명 + 인증서.**
- **DDNS:** 제어판 → 외부 액세스 → **DDNS** → `*.synology.me` 호스트명 추가(무료).
- **인증서:** 제어판 → 보안 → **인증서** → 해당 호스트명으로 **Let's Encrypt** 인증서 추가.

**5. 리버스 프록시(HTTPS 적용).** 제어판 → 로그인 포털 → **고급** → **리버스 프록시** → 생성:
- **소스:** 프로토콜 HTTPS, 호스트명 `couch.yourname.synology.me`, 포트 `443`.
- **대상:** 프로토콜 HTTP, 호스트명 `localhost`, 포트 `5984`.

**6. 테스트:** `https://couch.yourname.synology.me/_up` → `{"status":"ok"}`. 그 URL + 관리자 자격증명을 플러그인에
입력합니다.

> 나중에 Yjs 실시간 서버를 쓰려면 **두 번째** 리버스 프록시 항목을 추가하고, 거기서는 **WebSocket** 커스텀 헤더도 켜야
> 합니다([시놀로지 + WebSocket](#httpswss로-노출하기) 참고).

## 모든 CouchDB 호스트의 공통 요건

어떤 경로든 다음 네 가지는 동일합니다:

- **영속 저장**을 `/opt/couchdb/data`에 마운트 — 항상 실제 볼륨/폴더로, 휘발성 컨테이너 레이어 금지(재배포 시 구성원
  데이터 유실). 조직 규모는 작아 보통 수 GB면 충분(첨부가 많으면 늘리세요).
- **HTTPS 프록시.** Obsidian 모바일은 `https://`에만 접속. Let's Encrypt 인증서를 단 리버스 프록시, 또는 TLS를 자동
  제공하는 플랫폼을 사용.
- **강력한 관리자 비밀번호** — 플러그인이 구성원 프로비저닝에 **운영자 기기에서만** 사용. 구성원은 자신의 최소 권한 계정을
  받으며, 관리자 자격증명은 절대 구성원에게 주지 않습니다.
- **소박한 사양.** 단일 노드 CouchDB는 가벼워 **1 vCPU / 1 GB RAM** 로 한 워크스페이스를 무난히 처리; 클러스터링 불필요. 공식
  `couchdb:3` 이미지는 멀티아치(x86-64 **및** arm64 / 라즈베리파이).

## CouchDB 호스팅 선택지

CouchDB는 표준 소프트웨어라, 플러그인은 HTTPS URL + 관리자 계정만 있으면 됩니다. 상세 비교:

**① 직접 보유한 하드웨어 (NAS / 라즈베리파이 / 미니PC / 홈서버)**
- *적합:* 이미 상시 켜진 하드웨어 보유, **월 비용 0**과 완전한 데이터 소유를 원함.
- *구축:* Docker로 `couchdb:3` 실행(NAS UI / Portainer / CLI), `/opt/couchdb/data`에 볼륨 마운트, `COUCHDB_USER` /
  `COUCHDB_PASSWORD` 설정(따라하기 B 참고).
- *노출:* 가정망은 고정 공인 IP나 열린 인바운드 포트가 드뭅니다. NAS 리버스 프록시 + DDNS + Let's Encrypt, **또는**
  터널(Cloudflare Tunnel / Tailscale)을 사용.
- *주의:* 많은 ISP가 **CGNAT**를 쓰거나 80/443을 막아 포트포워딩이 안 됨 → 터널 필요. **데이터 폴더 백업**을 예약.
  가동률은 전원·인터넷에 의존.

**② 클라우드 VPS + Docker (Hetzner, DigitalOcean, Vultr, Linode, AWS Lightsail, Oracle Cloud 항상 무료)**
- *적합:* 원격 구성원, 고정 가정용 IP 없음, 또는 안정적 공인 IP를 원하고 리눅스 관리가 부담 없음.
- *구축:* 따라하기 A 참고 — 가장 작은 티어(1 vCPU / 1–2 GB), Docker + localhost 바인딩 CouchDB + Caddy로 HTTPS.
- *비용:* 소형 VPS ≈ 월 몇 달러(Hetzner가 가장 저렴); **Oracle Cloud 항상 무료**는 ARM Ampere 인스턴스로 $0 가능
  (가입 쿼터/가용성은 리전마다 다름).
- *주의:* OS 패치·방화벽·백업은 직접. **`5984`는 localhost / Docker 네트워크에 묶고 443만** 프록시로 노출 — CouchDB
  포트를 인터넷에 공개하지 마세요. 자동 보안 업데이트 켜기.

**③ PaaS / 원클릭 컨테이너 (Railway, Render, Fly.io)**
- *적합:* 서버 OS를 관리하고 싶지 않음; HTTPS·도메인이 자동.
- *구축:* 공식 `couchdb:3` 이미지를 배포하고 `/opt/couchdb/data`에 **영속 볼륨/디스크 연결**, `COUCHDB_USER` /
  `COUCHDB_PASSWORD` 설정. 플랫폼이 플러그인용 `https://…` URL을 제공.
- *주의:* **무료 티어는 슬립·미영속 가능** — 실사용은 실제 볼륨이 붙은 유료 플랜으로. 컨테이너가 상시 가동되고 HTTP
  포트를 노출하는지 확인. 저장/이그레스는 과금.

**④ 관리형 CouchDB (IBM Cloudant)**
- *적합:* 서버 관리 0; SaaS와 그 요금 모델을 수용.
- *구축:* Cloudant 인스턴스를 만들고 HTTPS 엔드포인트 + 발급 자격증명을 플러그인 관리자 URL로 사용.
- *주의:* Cloudant는 CouchDB 호환이지만 **동일하지 않음** — 요청률 기반 과금(라이트 플랜은 처리량 제한), 그리고 자체
  호스팅 `_users`와 다른 IAM/API 키 인증 모델. 플러그인의 자동 프로비저닝(`_users` 계정 + DB별 `_security` 생성)은
  표준 CouchDB 대상이므로 **체험 인스턴스에서 초대/프로비저닝을 먼저 검증**하세요. 데이터 거주지는 선택한 IBM 리전을 따름.

---

# Yjs 실시간 서버 (선택)

**실시간 공동 편집**에만 필요 — 파일 동기화(CouchDB)와 독립적이라, **파일 동기화만 쓸 거면 통째로 건너뜁니다.** CouchDB가
동작한 *뒤* 구축하세요. 구동 파일은 [`yjs/`](yjs/)에 있습니다:

- [`yjs/server.js`](yjs/server.js) — y-websocket 서버. 두 가지 인증 모드(공간별 HMAC `YJS_SECRET`, 또는 레거시 전역
  `YJS_TOKEN`).
- [`yjs/Dockerfile`](yjs/Dockerfile) / [`yjs/docker-compose.yml`](yjs/docker-compose.yml) /
  [`yjs/package.json`](yjs/package.json) — 컨테이너 빌드 + 실행(영속 저장은 `./data`, LevelDB).
- [`yjs/disable-yjs-accesslog.sh`](yjs/disable-yjs-accesslog.sh) — 리버스 프록시 접근 로그에 `?token=`이 남지 않게
  하는 시놀로지 DSM 헬퍼.

## 따라하기: CouchDB와 같은 호스트에 Yjs

**1. 파일을 서버로 가져오기**(레포 클론, 또는 `server/yjs/` 폴더 복사):
```bash
git clone https://github.com/wakeyi-git/obsidian-covault.git
cd obsidian-covault/server/yjs
```

**2. 시크릿 설정 후 시작.** 길고 무작위인 `YJS_SECRET`을 생성합니다(이게 HMAC 키이며, 같은 값을 플러그인에 붙여넣습니다):
```bash
echo "YJS_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d --build
docker compose logs -f          # 기동 로그에 auth: hmac (per-space) 가 보여야 함
```
LAN에서 점검: `http://<host>:1234` → `Yjs WebSocket server OK`. (`YJS_SECRET`이 `CHANGE_ME` 같은 placeholder거나
16자 미만이면 서버가 기동을 거부합니다 — 의도된 동작입니다.)

**3. `wss://`로 노출.** `yjs.example.com` → `localhost:1234` 리버스 프록시 항목을 추가:
- **Caddy:** Caddyfile에 블록을 추가하고 reload(WebSocket 자동 처리):
  ```caddyfile
  yjs.example.com {
      reverse_proxy localhost:1234
      log { output discard }      # ?token= 을 접근 로그에서 제외
  }
  ```
- **시놀로지:** 두 번째 리버스 프록시 항목(`yjs.yourname.synology.me` → `localhost:1234`)을 만들고 **WebSocket
  헤더를 켜야** 합니다 — [시놀로지 + WebSocket](#httpswss로-노출하기) 참고.

**4. 플러그인 설정.** 설정 → **Yjs 서버 URL** = `wss://yjs.example.com`, **Yjs 공간 시크릿(HMAC)** = `YJS_SECRET`과
정확히 같은 값. 실시간을 켜고 공동 공간을 **배포**하면 공간별 서명 토큰이 구성원에게 자동 발급됩니다.

## 안전하게 만들기 (실사용 필수)

1. **포트 1234를 직접 노출하지 마세요.** 항상 **HTTPS 리버스 프록시(`wss://`)** 뒤에 두고 WebSocket
   `Upgrade`/`Connection` 헤더를 전달합니다.
2. **`YJS_SECRET` 일치.** 서버 환경변수와 플러그인의 *Yjs 공간 시크릿(HMAC)* 은 **같은 값**이어야 합니다. 그러면
   유출된 공간 토큰도 해당 공간 room만 접근 가능(서버가 room이 `class_<c>/share/<s>/`로 시작하는지 검증).
3. **토큰을 로그에 남기지 마세요.** 토큰은 `?token=` 쿼리로 전달되므로 프록시/CDN/모니터링의 쿼리 로깅을
   마스킹/비활성화(시놀로지 DSM: [`yjs/disable-yjs-accesslog.sh`](yjs/disable-yjs-accesslog.sh); Caddy:
   `log { output discard }`; nginx: `access_log off` 또는 `$args` 제거 포맷). 토큰은 WSS로 전송되어 전송 중 노출은
   없으며, 위험은 평문 토큰이 로그에 쌓이는 것입니다.

## 모든 Yjs 호스트의 공통 요건

이것은 **직접 운영하는 서버(`yjs/`)** 이지 범용 Yjs 서비스가 아닙니다. 어디서 돌리든:

- **상시 가동되는 장수명 프로세스.** WebSocket 세션은 지속적이라, 유휴 시 인스턴스를 0으로 줄이는 플랫폼은 실시간
  세션을 끊습니다. 상시 가동 인스턴스를 고르세요.
- **LevelDB용 영속 볼륨**(컨테이너의 `/data`) — 재시작 시 스냅샷되지 않은 상태가 사라지지 않게. (정본은 플러그인
  스냅샷으로 CouchDB에 남고, LevelDB 캐시는 재시작을 매끄럽게 할 뿐입니다.)
- **WSS 종단 + WebSocket 통과** — 프록시가 `Upgrade`/`Connection`을 전달하고 장수명 연결을 허용해야 함(읽기 타임아웃
  상향).
- **작은 사양.** y-websocket은 활성 문서를 메모리에 두며, 조직 규모엔 **1 vCPU / 512 MB–1 GB** 면 충분.

## Yjs 호스팅 선택지

**① CouchDB와 같은 머신** — *운영이 가장 단순.* 한 머신, 두 라우트의 리버스 프록시 하나(`couch.` 서브도메인 → `5984`,
`yjs.` 서브도메인 → `1234`). 실시간은 버스트성 WebSocket, CouchDB는 평문 HTTP라 조직 부하에선 1–2 GB 머신에서 무난히
공존합니다.

**② 클라우드 VPS / 홈서버 (CouchDB와 분리)** — 따라하기와 동일한 단계를 별도 호스트에서. 512 MB–1 GB면 충분. 실시간을
파일 동기화와 분리하거나 구성원에 더 가까운 리전에 두고 싶을 때 좋음.

**③ PaaS (Railway / Render / Fly.io)** — `yjs/` 이미지를 `/data` **영속 볼륨**과 함께 배포. 플랜이 **상시 가동
(scale-to-zero 아님)** 이고 WebSocket을 통과시키는지 확인하세요; 아니면 유휴 세션이 끊깁니다. TLS·도메인은 자동.

**④ ⚠️ 매니지드 Yjs SaaS (PartyKit, Liveblocks, Hocuspocus Cloud, y-sweet) — 그대로 대체 불가.** 이들은 이 서버의
공간별 HMAC `?token=` 검증이나 `class_<c>/share/<s>/` room 검사를 구현하지 않으므로, 플러그인의 공간 격리 보안 모델이
적용되지 않습니다(토큰이 의도보다 넓은 접근을 허용). 이 서버를 그대로 운영하세요 — 인증 방식을 다른 백엔드에 이식하는 것은
가능하지만 설정이 아니라 수동 작업입니다.

---

## HTTPS/WSS로 노출하기

두 서버 앞에 실제 인증서를 두는 방법. **모두 CouchDB에도 동일하게 적용**됩니다 — 포트를 `1234` 대신 `5984`로 가리키면
됩니다.

**Caddy** — 도메인만 가리키면 HTTPS가 자동 발급/갱신되고 WebSocket도 기본 지원. 완전한 site 예:
```caddyfile
yjs.example.com {
    reverse_proxy localhost:1234
    log { output discard }          # ?token= 을 접근 로그에서 제외
}
```
요건: 도메인 A 레코드가 서버를 가리키고, 80/443 포트가 열려 있어야 함(Caddy는 ACME 챌린지에 80이 필요).

**nginx** — WebSocket 업그레이드 헤더와 긴 읽기 타임아웃이 명시적으로 필요(없으면 실시간이 조용히 연결 실패):
```nginx
location / {
    proxy_pass http://127.0.0.1:1234;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_read_timeout 3600s;        # 장수명 WS 연결 유지
    access_log off;                  # 또는 $args(?token=)를 제거하는 log_format
}
```

**시놀로지 + WebSocket** — DSM 리버스 프록시는 기본적으로 WebSocket을 통과시키지 **않습니다.** 항목 생성 후 열어서 →
**사용자 지정 헤더** → **생성** → **WebSocket**(이게 `Upgrade`/`Connection` 헤더를 넣어 줍니다). 이게 없으면 CouchDB
동기화는 되지만 **실시간이 연결되지 않습니다.**

**Cloudflare Tunnel** — 서버 옆에서 `cloudflared`를 돌려 공개 호스트명 → `localhost:1234`를 **포트포워딩·고정 IP 없이**
매핑; TLS는 Cloudflare 엣지에서 종단되고 WebSocket도 지원. CGNAT 환경에 이상적. `?token=`이 남지 않게 엣지
로깅/분석에서 쿼리 문자열을 제외하세요.

**Tailscale Funnel** — tailnet 노드를 `*.ts.net` 호스트명으로 TLS와 함께 공개, 역시 포트포워딩 없이. Funnel은 정해진
포트(443 / 8443 / 10000)만 제공하고 대역폭 제한이 있음 — 워크스페이스용엔 충분하지만 대규모 공개 트래픽엔 부적합.

**Traefik** — 컨테이너 자동 감지 + Let's Encrypt; 여러 서비스를 돌리며 손수 쓴 vhost 대신 라벨 기반 라우팅을 원할 때 편리.

---

## 문제 해결

| 증상 | 원인 & 해결 |
|---|---|
| **데스크톱(LAN)은 되는데 폰/외부에서 안 됨** | `http://` 나 LAN IP를 썼음. 모바일은 실제 `https://` 도메인 + 인증서 필요 — 리버스 프록시 단계를 마치세요. |
| **`Connection refused` / URL에 못 닿음** | 컨테이너 미실행(`docker compose ps`), 포트 오류, 또는 방화벽이 443을 막음. 프록시가 `5984`로 CouchDB에 닿아야 함. |
| **`401 Unauthorized`** | 관리자 계정/비밀번호 오류, 또는 URL 누락. 플러그인의 CouchDB URL + 관리자 자격증명 재확인. |
| **CouchDB가 500 / "system databases" 오류** | 단일 노드 초기화를 빠뜨림 — `/_cluster_setup` 단계 실행(따라하기 A 4단계). |
| **인증서 무효 / 미발급** | A 레코드가 아직 서버를 안 가리킴(전파 지연), 또는 80 포트 닫힘(Caddy/Let's Encrypt가 ACME 챌린지에 필요). |
| **파일 동기화는 되는데 실시간이 연결 안 됨** | 프록시가 WebSocket을 통과 안 시킴. `Upgrade`/`Connection` 헤더(nginx) 또는 **WebSocket 사용자 지정 헤더**(시놀로지)를 추가; URL이 `wss://`인지 확인. |
| **Yjs 컨테이너가 시작 안 됨** | `YJS_SECRET`이 placeholder/너무 짧음. 실제 32바이트 hex 값(`openssl rand -hex 32`) 설정. `docker compose logs` 확인. |
| **실시간 토큰 거부됨** | 플러그인의 *Yjs 공간 시크릿* ≠ 서버 `YJS_SECRET`. 동일하게 맞춘 뒤 공간을 **재배포**해 토큰 재발급. |
| **Excalidraw 실시간 안 됨** | Excalidraw 플러그인 설치 + `.excalidraw.md` 형식 사용(순수 `.excalidraw`는 미지원). |

---

## 보안 체크리스트

실제 조직 전에:

- [ ] CouchDB는 **오직** HTTPS로만 접근 가능; 생 `5984` 포트는 인터넷에 공개되지 않음.
- [ ] 관리자 비밀번호는 강력하며 **운영자 기기에만** 존재 — 구성원은 절대 받지 않음.
- [ ] `YJS_SECRET`은 새 무작위 값(placeholder 아님)이고, 서버와 플러그인에서 동일.
- [ ] 리버스 프록시/CDN이 `?token=` 쿼리를 **로깅하지 않음**.
- [ ] CouchDB **데이터 볼륨을 정기 백업**.
- [ ] 시크릿/토큰을 레포에 절대 커밋 안 함 — 플러그인은 Obsidian Secret Storage에 보관하고 설정 내보내기에서 제외하며,
      서버의 실제 시크릿은 서버에만 둡니다.
