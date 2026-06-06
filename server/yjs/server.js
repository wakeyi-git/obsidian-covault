const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");
const { setupWSConnection } = require("y-websocket/bin/utils");

const host = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "1234", 10);

// 인증 모드:
//  - YJS_SECRET 설정 → HMAC 모드: 공간(room)별 서명 토큰을 검증한다(권장). 토큰이 유출돼도 해당 공간만.
//  - YJS_SECRET 없고 YJS_TOKEN만 → 레거시 전역 토큰 모드(?token=...이 일치해야 함).
//  - 둘 다 없으면 인증 off.
const secret = process.env.YJS_SECRET || "";
const legacyToken = process.env.YJS_TOKEN || "";

// 알려진 플레이스홀더/너무 짧은 시크릿으로 운영되는 사고를 막는다 — 설정됐다면 반드시 교체해야 한다.
function rejectPlaceholder(name, value) {
  if (!value) return;
  if (/^(CHANGE_ME|changeme|replace)/i.test(value) || value.length < 16) {
    console.error(`[FATAL] ${name} must be replaced with a long random value before use (>=16 chars, not a placeholder).`);
    process.exit(1);
  }
}
rejectPlaceholder("YJS_SECRET", secret);
rejectPlaceholder("YJS_TOKEN", legacyToken);

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 요청 URL에서 room 이름(경로)과 token(query)을 뽑는다. y-websocket은 room을 경로 세그먼트로 보낸다. */
function parseReq(reqUrl) {
  const u = new URL(reqUrl, "http://localhost");
  const room = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const token = u.searchParams.get("token");
  return { room, token };
}

/** HMAC 모드 검증: 서명 일치 + room이 payload의 class/space로 시작 + (exp 있으면) 미만료. */
function verifyHmac(room, token) {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac("sha256", secret).update(payloadB64).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return false;
  }
  if (!payload || typeof payload.c !== "string" || typeof payload.s !== "string") return false;
  // room이 이 토큰이 허용하는 공간(ws_<c>/share/<s>/...)에 속하는지 확인 → 공간 간 격리.
  const prefix = `ws_${payload.c}/share/${payload.s}/`;
  if (!room.startsWith(prefix)) return false;
  if (typeof payload.e === "number" && Math.floor(Date.now() / 1000) > payload.e) return false;
  return true;
}

// 헬스체크용 HTTP 응답(리버스 프록시/모니터링 확인용)
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Yjs WebSocket server OK");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (conn, req) => {
  // 주의: 토큰을 query로 받으므로 리버스 프록시 접근 로그에서 ?token= 을 마스킹하도록 설정하세요.
  if (secret) {
    const { room, token } = parseReq(req.url || "");
    if (!verifyHmac(room, token)) {
      conn.close(4001, "unauthorized");
      return;
    }
  } else if (legacyToken) {
    let provided = null;
    try {
      provided = new URL(req.url, "http://localhost").searchParams.get("token");
    } catch {
      /* URL 파싱 실패 → 거부 */
    }
    if (provided !== legacyToken) {
      conn.close(4001, "unauthorized");
      return;
    }
  }
  setupWSConnection(conn, req);
});

const mode = secret ? "hmac (per-space)" : legacyToken ? "global token" : "off";
server.listen(port, host, () => {
  console.log(`Yjs WebSocket server listening on ws://${host}:${port} (auth: ${mode})`);
});
