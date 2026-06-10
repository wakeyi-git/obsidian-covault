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
import BetterSqlite3 from "better-sqlite3";
import * as Y from "yjs";
import crypto from "crypto";
import { rejectPlaceholder, parseRoom, verifyToken } from "./auth.js";
import { CouchClient } from "./couch.js";

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

function sha256Hex(s) {
	return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** CouchDB 스냅샷/시드 대상: 마크다운 문서만. .excalidraw.md는 클라이언트가 세션 종료 시 저장한다. */
function isSnapshotTarget(dbPath) {
	const lower = dbPath.toLowerCase();
	return lower.endsWith(".md") && !lower.endsWith(".excalidraw.md");
}

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
	const part = await couch.getDoc(claims.d, `rtpart:${room.dbPath}`);
	if (part && !part.deleted) return Array.isArray(part.memberIds) && part.memberIds.includes(claims.m);
	const control = await couch.getDoc(claims.d, "rtcontrol").catch(() => null);
	return !control?.sharedReadOnly;
}

// ---------------------------------------------------------------------------
// 참가자 변경 즉시 반영 — 활성 문서가 있는 DB의 _changes를 감시(longpoll)하고,
// rtpart/rtcontrol 변경 시 영향받는 문서의 연결을 모두 닫는다 → 클라이언트가 자동 재접속하며
// 재인가되므로 제거된 멤버만 거부되고 나머지는 끊김 없이 복귀한다.
// ---------------------------------------------------------------------------
const activeDocs = new Map(); // documentName -> { db, dbPath }
const watchers = new Map(); // db -> { abort: AbortController, count: number }
let hocuspocusInstance = null; // onListen에서 채워짐(closeConnections용)

function onControlChange(dbName, changedIds) {
	if (!hocuspocusInstance) return;
	for (const id of changedIds) {
		for (const [name, info] of activeDocs) {
			if (info.db !== dbName) continue;
			// rtcontrol(기본 정책) 변경 → DB의 모든 활성 문서 재인가, rtpart 변경 → 해당 파일만.
			if (id === "rtcontrol" || id === `rtpart:${info.dbPath}`) {
				console.log(`[authz] ${id} changed in ${dbName} — closing connections of "${name}" for re-auth`);
				hocuspocusInstance.closeConnections(name);
			}
		}
	}
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
	},

	/** 헬스체크(리버스 프록시/모니터링 확인용). throw null = 기본 응답 중단(v4 onRequest 규약). */
	async onRequest({ response }) {
		response.writeHead(200, { "Content-Type": "text/plain" });
		response.end("CoVault realtime server OK");
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
		return { claims, room }; // → context (onStoreDocument lastContext, 강퇴 재인가에 사용)
	},

	/** 문서 로드: SQLite 복원 → 없으면 CouchDB note 문서로 시드(마크다운 전용). */
	async onLoadDocument({ document, documentName, context }) {
		const row = selectDoc.get({ name: documentName });
		if (row?.data) {
			Y.applyUpdate(document, row.data);
			return;
		}
		const room = context?.room ?? parseRoom(documentName);
		const claims = context?.claims;
		if (!couch || !room || !claims || !isSnapshotTarget(room.dbPath)) return;
		try {
			const note = await couch.getDoc(claims.d, `note:${room.dbPath}`);
			if (note && !note.deleted && typeof note.content === "string" && note.content.length > 0) {
				// Y.Text 키 "content"는 클라이언트 RealtimeManager.startSession()의 ydoc.getText("content")와 일치해야 한다.
				document.getText("content").insert(0, note.content);
				console.log(`[seed] "${documentName}" seeded from CouchDB note (${note.content.length} chars)`);
			}
		} catch (e) {
			// 시드 실패 시 빈 문서로 열면 스냅샷이 기존 내용을 비울 수 있다 → fail-closed로 연결 거부.
			console.error(`[seed] failed for "${documentName}": ${e?.message ?? e}`);
			throw new Error("document seed failed");
		}
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
		upsertDoc.run({ name: documentName, data: Buffer.from(Y.encodeStateAsUpdate(document)) });

		const ctx = lastContext ?? context;
		const room = ctx?.room ?? parseRoom(documentName);
		const claims = ctx?.claims;
		if (!couch || !room || !claims || !isSnapshotTarget(room.dbPath)) return;

		const content = document.getText("content").toString();
		if (content.length === 0) return; // 빈 내용으로 기존 문서를 덮어쓰지 않음(데이터 손실 방지)
		const contentHash = sha256Hex(content);
		const id = `note:${room.dbPath}`;
		const existing = await couch.getDoc(claims.d, id).catch(() => null);
		if (existing && !existing.deleted && existing.contentHash === contentHash) return; // 변화 없음

		const now = Date.now();
		await couch.putDoc(claims.d, {
			_id: id,
			type: "note",
			schemaVersion: 1,
			workspaceId: claims.c,
			// 소유자 표기는 기존 문서를 보존, 신규면 공간 id(공유 공간 문서의 관례)를 쓴다.
			memberId: existing?.memberId ?? room.spaceId,
			path: room.dbPath,
			content,
			contentHash,
			mtime: now,
			deleted: false,
			version: (existing?.version ?? 0) + 1,
			lastModifiedBy: claims.m, // 마지막 변경을 일으킨 연결의 주체
			lastModifiedRole: claims.r,
			lastModifiedDeviceId: "covault-rt-server",
			updatedAt: new Date(now).toISOString(),
		});
		console.log(`[snapshot] "${documentName}" -> ${claims.d}/${id} (v${(existing?.version ?? 0) + 1})`);
	},

	/** 활성 문서 해제 + 감시 정리. */
	async afterUnloadDocument({ documentName }) {
		const info = activeDocs.get(documentName);
		if (!info) return;
		activeDocs.delete(documentName);
		releaseWatcher(info.db);
	},
});

server.listen().then(() => {
	console.log(`CoVault realtime server listening on ws://${host}:${port}`);
	console.log(`  auth: hmac per-member (file-level: ${couch ? "on (CouchDB)" : "OFF — set COUCHDB_URL"})`);
	console.log(`  persistence: SQLite ${sqlitePath}, snapshots: ${couch ? "CouchDB note docs" : "disabled"}`);
});
