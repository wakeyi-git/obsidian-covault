/**
 * CoVault 실시간 서버 — Hocuspocus v4 기반. 기술문서 §19.
 *
 * y-websocket 서버(구 server/yjs)와의 차이:
 *   - 토큰이 URL 쿼리가 아니라 WebSocket 연결 후 **인증 메시지**로 전달된다
 *     → 리버스 프록시 접근 로그에 토큰이 남지 않는다(로그 마스킹 불필요).
 *   - 문서별 인가를 서버가 강제한다: 토큰 클레임(m/r) + CouchDB의 rtpart(파일별 참여자)/
 *     rtcontrol(읽기 전용 기본값) 문서로 입장을 거부한다. 참가자 제거는 _changes 감시로 즉시 반영.
 *   - Yjs 문서 상태를 SQLite에 영속화하고(서버 재시작 복원), 마크다운 문서는 CouchDB note 문서로도
 *     스냅샷을 저장한다(디바운스) → 클라이언트의 단일 작성자 선출·주기 스냅샷이 필요 없다.
 *
 * 환경 변수:
 *   HOST(0.0.0.0) PORT(1234)
 *   YJS_SECRET            (필수) HMAC 시크릿 — 플러그인 'Yjs 공간 시크릿'과 동일
 *   SQLITE_PATH           (기본 /data/hocuspocus.sqlite) Yjs 상태 영속화 파일
 *   COUCHDB_URL           (권장) CouchDB 주소 — 없으면 공간 단위 인가 + SQLite 영속만 동작(시드/스냅샷/파일 인가 비활성)
 *   COUCHDB_USER/PASSWORD CouchDB 계정(전용 서비스 계정 권장, admin 가능)
 *   STORE_DEBOUNCE_MS     (기본 2000) onStoreDocument 디바운스
 *   STORE_MAX_DEBOUNCE_MS (기본 10000) 최대 지연 — 이 시간 안엔 반드시 저장
 */
import { Server } from "@hocuspocus/server";
import { ResetConnection } from "@hocuspocus/common";
import BetterSqlite3 from "better-sqlite3";
import { readFileSync } from "node:fs";
import { rejectPlaceholder, parseRoom, verifyToken } from "./auth.js";
import { CouchClient } from "./couch.js";
// 문서 로드 시드·스냅샷·언로드 로직은 docLifecycle.js로 분리(의존성 주입 → vitest 검증 가능).
import { createDocLifecycle, isSnapshotTarget } from "./docLifecycle.js";
// 인가 규칙·권한 변경 재인가 대상 선별(순수 로직)은 authz.js로 분리 — vitest로 고정(test/server/authz.test.ts).
import { memberAllowed, connectionsToClose } from "./authz.js";

// 배포된 서버 빌드 버전(package.json) — health 엔드포인트에 노출해 NAS에 어떤 빌드가 떠 있는지 확인하게 한다.
// (실시간 서버는 플러그인과 별도로 재배포되므로 배포 누락 진단에 필요.) 읽기 실패해도 기동을 막지 않는다.
const SERVER_VERSION = (() => {
	try {
		return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version || "unknown";
	} catch {
		return "unknown";
	}
})();

const host = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "1234", 10);
const secret = process.env.YJS_SECRET || "";
const sqlitePath = process.env.SQLITE_PATH || "/data/hocuspocus.sqlite";
const debounce = parseInt(process.env.STORE_DEBOUNCE_MS || "2000", 10);
const maxDebounce = parseInt(process.env.STORE_MAX_DEBOUNCE_MS || "10000", 10);

rejectPlaceholder("YJS_SECRET", secret);
if (!secret) {
	console.error("[FATAL] YJS_SECRET is required. Set it to the same value as the plugin's 'Yjs space secret'.");
	process.exit(1);
}

// --- CouchDB(인가 조회 + 시드/스냅샷). 미설정이면 경고 후 공간 단위 인가만으로 동작. ---
const couchUrl = process.env.COUCHDB_URL || "";
if (/^(CHANGE_ME|changeme|replace)/i.test(process.env.COUCHDB_PASSWORD || "")) {
	console.error("[FATAL] COUCHDB_PASSWORD is still a placeholder — set the real service account password.");
	process.exit(1);
}
const couch = couchUrl ? new CouchClient(couchUrl, process.env.COUCHDB_USER || "", process.env.COUCHDB_PASSWORD || "") : null;
if (!couch) {
	console.warn(
		"[WARN] COUCHDB_URL is not set — file-level authorization, document seeding and CouchDB snapshots are DISABLED. " +
			"Set COUCHDB_URL/COUCHDB_USER/COUCHDB_PASSWORD for full operation.",
	);
}

// --- SQLite: Yjs 문서 상태 영속화(@hocuspocus/extension-sqlite와 동일 스키마) ---
const db = new BetterSqlite3(sqlitePath);
db.pragma("journal_mode = WAL");
db.exec('CREATE TABLE IF NOT EXISTS "documents" ("name" varchar(255) NOT NULL, "data" blob NOT NULL, UNIQUE(name))');
const selectDoc = db.prepare('SELECT data FROM "documents" WHERE name = $name ORDER BY rowid DESC');
const upsertDoc = db.prepare('INSERT INTO "documents" ("name", "data") VALUES ($name, $data) ON CONFLICT(name) DO UPDATE SET data = $data');
const deleteDocRow = db.prepare('DELETE FROM "documents" WHERE name = $name');

// 문서별 소량 메타데이터(TEXT 키·값). Excalidraw 신선도 앵커(마지막으로 일치를 확인한 CouchDB note 해시)에
// 사용한다 — 서버가 excalidraw를 CouchDB 스냅샷하지 않아 Y 상태→파일 해시를 만들 수 없으므로(평가 P1-1 #3).
db.exec('CREATE TABLE IF NOT EXISTS "covault_meta" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)');
const selectMeta = db.prepare('SELECT value FROM "covault_meta" WHERE key = $key');
const upsertMeta = db.prepare('INSERT INTO "covault_meta" ("key", "value") VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = $value');
const deleteMeta = db.prepare('DELETE FROM "covault_meta" WHERE key = $key');


// ---------------------------------------------------------------------------
// 파일 단위 인가 — 플러그인 src/core/realtime/participants.ts 의 memberAllowed()와 동일 규칙.
//   rtpart:<dbPath> 있음(& !deleted) → memberIds에 포함된 멤버만
//   없음 → rtcontrol.sharedReadOnly가 켜져 있으면 거부, 아니면 전원 허용
//   manager(교사)와 mirror 공간(1:1)은 항상 허용
// ---------------------------------------------------------------------------
async function authorize(claims, room) {
	if (claims.r === "manager") return true;
	if (room.spaceId.startsWith("mirror-")) return true; // 개인 mirror 1:1 — 파일 인가 없음
	if (!couch) return true; // CouchDB 미연동: 공간 단위 인가만(기동 시 경고됨)
	// rtpart가 있으면 rtcontrol은 무관하므로 추가 조회를 생략(원래 단축 평가 유지). 판정 규칙은 authz.memberAllowed.
	const part = await couch.getDoc(claims.d, `rtpart:${room.dbPath}`);
	if (part && !part.deleted) return memberAllowed(claims, room, part, null);
	const control = await couch.getDoc(claims.d, "rtcontrol").catch(() => null);
	return memberAllowed(claims, room, null, control);
}

// ---------------------------------------------------------------------------
// 참가자 변경 즉시 반영 — 활성 문서가 있는 DB의 _changes를 감시(longpoll)하고,
// rtpart/rtcontrol 변경 시 영향받는 문서의 연결을 모두 닫는다 → 클라이언트가 자동 재접속하며
// 재인가되므로 제거된 멤버만 거부되고 나머지는 끊김 없이 복귀한다.
// ---------------------------------------------------------------------------
const activeDocs = new Map(); // documentName -> { db, dbPath }
const watchers = new Map(); // db -> { abort: AbortController, count: number }

/**
 * CouchDB 스냅샷 실패 가시성 — 연속 실패 수와 마지막 오류를 헬스 엔드포인트에 노출한다.
 * 서버-CouchDB 불통 상태로 세션이 계속되면 비실시간/오프라인 멤버가 옛 본을 받는데,
 * 이전엔 콘솔 로그뿐이라 아무도 몰랐다.
 */
let couchFailCount = 0;
let lastCouchError = null; // { at: ISO, msg }
function noteCouchOk() {
	couchFailCount = 0;
}
function noteCouchFail(e) {
	couchFailCount++;
	lastCouchError = { at: new Date().toISOString(), msg: String(e?.message ?? e).slice(0, 200) };
}

/**
 * 토큰 만료의 활성 연결 소급 — 문서별 "가장 이른 만료(epoch sec)"를 기억해 두고, 주기 점검에서
 * 지난 문서의 연결을 모두 닫는다. 재접속 시 onAuthenticate가 만료 토큰만 거부하므로(재인가),
 * 나머지 참가자는 끊김 없이 복귀한다(rtpart 변경 강퇴와 동일하게 검증된 경로).
 */
const docMinExp = new Map(); // documentName -> epoch sec
function noteTokenExp(documentName, expSec) {
	if (typeof expSec !== "number") return;
	const prev = docMinExp.get(documentName);
	if (prev == null || expSec < prev) docMinExp.set(documentName, expSec);
}
let hocuspocusInstance = null; // onListen에서 채워짐(closeConnections용)

// 문서 수명주기(로드 시드·스냅샷·언로드) — SQLite·CouchDB·연결 종료를 주입(테스트는 docLifecycle.test).
const lifecycle = createDocLifecycle({
	couch,
	sqlite: {
		get: (name) => selectDoc.get({ name })?.data ?? null,
		put: (name, data) => upsertDoc.run({ name, data }),
		del: (name) => deleteDocRow.run({ name }),
		getMeta: (key) => selectMeta.get({ key })?.value ?? null,
		putMeta: (key, value) => upsertMeta.run({ key, value }),
		delMeta: (key) => deleteMeta.run({ key }),
	},
	closeConnections: (name) => hocuspocusInstance?.closeConnections(name),
	noteCouchOk,
	noteCouchFail,
});

// 권한 문서(rtpart/rtcontrol) 변경 → 영향 문서의 **연결별 재인가**. 전원 종료(closeConnections) 대신
// 현재 권한으로 각 연결을 재평가해 더는 허용 안 되는 연결만 닫는다 → 멤버 추가는 누구도 안 끊기고(churn 0),
// 제거는 그 멤버만 끊긴다. _changes는 한 번에 여러 id를 줄 수 있으나, 재인가는 '현재 권한 재조회+재평가'라
// 멱등하므로(같은 연결을 두 번 닫아도 무해) 별도 순서 보장이 필요 없다.
function onControlChange(dbName, changedIds) {
	if (!hocuspocusInstance || !couch) return;
	const affected = new Set();
	for (const id of changedIds) {
		for (const [name, info] of activeDocs) {
			if (info.db !== dbName) continue;
			// rtcontrol(기본 정책) 변경 → DB의 모든 활성 문서, rtpart 변경 → 해당 파일만.
			if (id === "rtcontrol" || id === `rtpart:${info.dbPath}`) affected.add(name);
		}
	}
	for (const name of affected) {
		void reauthDocument(name).catch((e) => console.error(`[authz] re-auth failed for "${name}": ${e?.message ?? e}`));
	}
}

/**
 * 한 문서의 연결을 현재 권한으로 재평가해 더는 허용되지 않는 연결만 닫는다(Hocuspocus 단건 종료).
 * 닫힌 연결은 클라이언트가 재접속하며 onAuthenticate를 다시 통과해야 하므로, 제거된 멤버만 거부되고
 * 나머지는 애초에 닫히지 않아 끊김이 없다. 조회 실패 시엔 아무도 닫지 않는다(가용성 우선 — 다음 변경/만료
 * 점검이 재평가; 잘못 끊어 정상 협업을 깨지 않는다).
 */
async function reauthDocument(name) {
	const info = activeDocs.get(name);
	const doc = hocuspocusInstance?.documents?.get(name);
	if (!info || !doc) return;
	const rtpart = await couch.getDoc(info.db, `rtpart:${info.dbPath}`).catch(() => null);
	const rtcontrol = await couch.getDoc(info.db, "rtcontrol").catch(() => null);
	// Hocuspocus Connection: .context = onAuthenticate 반환값({claims, room}), .close({code,reason})로 단건 종료.
	const conns = doc.getConnections().map((c) => ({ ref: c, claims: c.context?.claims, room: c.context?.room }));
	const toClose = connectionsToClose(conns, rtpart, rtcontrol);
	for (const c of toClose) {
		console.log(`[authz] revoking ${c.claims?.m} from "${name}" — no longer authorized (rtpart/rtcontrol changed)`);
		try {
			c.ref.close(ResetConnection);
		} catch (e) {
			console.error(`[authz] close failed for ${c.claims?.m} on "${name}": ${e?.message ?? e}`);
		}
	}
	if (toClose.length === 0) console.log(`[authz] "${name}" re-evaluated — all current participants still authorized (no churn)`);
}

function ensureWatcher(dbName) {
	const w = watchers.get(dbName);
	if (w) {
		w.count++;
		return;
	}
	const abort = new AbortController();
	watchers.set(dbName, { abort, count: 1 });
	void couch.watchChanges(
		dbName,
		(id) => id === "rtcontrol" || id.startsWith("rtpart:"),
		(ids) => onControlChange(dbName, ids),
		abort.signal,
	);
}

function releaseWatcher(dbName) {
	const w = watchers.get(dbName);
	if (!w) return;
	if (--w.count <= 0) {
		w.abort.abort();
		watchers.delete(dbName);
	}
}

// ---------------------------------------------------------------------------
// 서버 구성
// ---------------------------------------------------------------------------
const server = new Server({
	address: host,
	port,
	debounce,
	maxDebounce,
	quiet: true,
	stopOnSignals: true,

	async onListen({ instance }) {
		hocuspocusInstance = instance;
		// 만료 토큰 주기 점검(60초) — 가장 이른 만료가 지난 문서의 연결을 닫아 재인가시킨다.
		const sweep = setInterval(() => {
			const nowSec = Math.floor(Date.now() / 1000);
			for (const [name, exp] of docMinExp) {
				if (nowSec <= exp) continue;
				docMinExp.delete(name); // 유효한 연결이 재인증하며 다시 등록한다
				console.log(`[authz] token expiry passed for "${name}" — closing connections for re-auth`);
				instance.closeConnections(name);
			}
		}, 60_000);
		sweep.unref?.(); // 점검 타이머가 프로세스 종료를 막지 않게
	},

	/** 헬스체크(리버스 프록시/모니터링 확인용). throw null = 기본 응답 중단(v4 onRequest 규약).
	 *  첫 줄("CoVault realtime server OK")은 호환성 계약 — 둘째 줄 CouchDB 상태, 셋째 줄 빌드 버전을 덧붙인다. */
	async onRequest({ response }) {
		const couchLine = !couch
			? "couch: disabled"
			: couchFailCount === 0
				? "couch: ok"
				: `couch: failing(${couchFailCount}) last=${lastCouchError?.at ?? "?"} ${lastCouchError?.msg ?? ""}`;
		response.writeHead(200, { "Content-Type": "text/plain" });
		response.end(`CoVault realtime server OK\n${couchLine}\nversion: ${SERVER_VERSION}`);
		throw null;
	},

	/** 인증 + 인가. throw → 클라이언트에 permission-denied(4403) close. */
	async onAuthenticate({ token, documentName, connectionConfig }) {
		const claims = verifyToken(secret, documentName, token);
		if (!claims) throw new Error("unauthorized: invalid or expired token");
		const room = parseRoom(documentName);
		if (!room) throw new Error("unauthorized: malformed room name");
		let allowed = false;
		try {
			allowed = await authorize(claims, room);
		} catch (e) {
			// 인가 조회 실패는 fail-closed(거부) — 빈 권한으로 입장시키지 않는다.
			console.error(`[authz] lookup failed for "${documentName}": ${e?.message ?? e}`);
			throw new Error("authorization lookup failed");
		}
		if (!allowed) throw new Error(`forbidden: ${claims.m} is not a participant of this file`);
		connectionConfig.isAuthenticated = true;
		noteTokenExp(documentName, claims.e); // 만료 주기 점검 대상으로 등록
		return { claims, room }; // → context (onStoreDocument lastContext, 강퇴 재인가에 사용)
	},

	/** 문서 로드: SQLite 복원 → 없으면 CouchDB note 문서로 시드(마크다운 전용). 교사 삭제 tombstone이면 로드 거부. */
	async onLoadDocument({ document, documentName, context }) {
		const room = context?.room ?? parseRoom(documentName);
		const claims = context?.claims;
		await lifecycle.loadDocument({ document, documentName, room, claims });
	},

	/** 활성 문서 등록 + 해당 DB의 rtpart/rtcontrol 감시 시작. */
	async afterLoadDocument({ documentName, context }) {
		const room = context?.room ?? parseRoom(documentName);
		const claims = context?.claims;
		if (!couch || !room || !claims || activeDocs.has(documentName)) return;
		activeDocs.set(documentName, { db: claims.d, dbPath: room.dbPath });
		if (!room.spaceId.startsWith("mirror-")) ensureWatcher(claims.d);
	},

	/**
	 * 문서 저장(디바운스): SQLite 영속화 + 마크다운이면 CouchDB note 스냅샷.
	 * throw 시 Hocuspocus v4가 디바운서에 남겨 재시도하며, 종료 시 pending store를 flush한다.
	 */
	async onStoreDocument({ document, documentName, context, lastContext }) {
		const ctx = lastContext ?? context;
		const room = ctx?.room ?? parseRoom(documentName);
		const claims = ctx?.claims;
		await lifecycle.storeDocument({ document, documentName, room, claims });
	},

	/** 활성 문서 해제 + 감시 정리. 스냅샷이 CouchDB에 안착했으면 SQLite 행도 지운다(다음 세션은 note에서 시드). */
	async afterUnloadDocument({ documentName }) {
		const info = activeDocs.get(documentName);
		if (!info) return;
		activeDocs.delete(documentName);
		releaseWatcher(info.db);
		docMinExp.delete(documentName);
		lifecycle.handleUnload(documentName, info.dbPath);
	},
});

server.listen().then(() => {
	console.log(`CoVault realtime server listening on ws://${host}:${port}`);
	console.log(`  auth: hmac per-member (file-level: ${couch ? "on (CouchDB)" : "OFF — set COUCHDB_URL"})`);
	console.log(`  persistence: SQLite ${sqlitePath}, snapshots: ${couch ? "CouchDB note docs" : "disabled"}`);
});
