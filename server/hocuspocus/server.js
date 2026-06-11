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
const deleteDocRow = db.prepare('DELETE FROM "documents" WHERE name = $name');

/** 교사 삭제 tombstone 여부 — 교사 삭제는 실시간 세션·스냅샷보다 우선한다(부활 방지). 구성원 삭제는 세션 보호가 우선. */
function isManagerTombstone(note) {
	return !!note?.deleted && note.deletedByRole === "manager";
}

/** 서버 스냅샷의 deviceId — note가 이 값이 아니면 마지막 변경은 클라이언트(파일 동기화)에서 왔다. */
const RT_DEVICE_ID = "covault-rt-server";

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
/**
 * SQLite가 CouchDB 스냅샷보다 앞서 있는 문서. onStoreDocument가 SQLite 저장 직후 표시하고
 * CouchDB 반영 성공 시 해제한다. 언로드 시 앞서 있지 않으면(=CouchDB가 정본) SQLite 행을 지워
 * 다음 세션이 CouchDB에서 시드되게 한다 — 세션 사이의 평문 동기화 편집이 옛 SQLite 상태에
 * 되돌려지는 사고(데이터 유실)를 막는다.
 */
const sqliteAhead = new Set(); // documentName
/**
 * 서버가 마지막으로 확인/기록한 CouchDB note의 contentHash. 스냅샷 직전 note가 이 값과 다르면
 * 세션 중 비실시간 멤버가 파일 동기화로 편집한 것 — Y 문서엔 병합되지 않으므로 그대로 덮으면
 * 그 편집이 유실된다. 덮기 전에 버전 문서(version:)로 보존해 버전 히스토리에서 복구 가능하게 한다.
 */
const lastCouchHash = new Map(); // documentName -> contentHash

/** 버전 문서 id용 단조 증가 타임스탬프(같은 ms 충돌 방지) — 클라이언트 VersionStore와 동형. */
let lastVersionMs = 0;
function nextVersionMs() {
	lastVersionMs = Math.max(Date.now(), lastVersionMs + 1);
	return lastVersionMs;
}
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

	/** 문서 로드: SQLite 복원 → 없으면 CouchDB note 문서로 시드(마크다운 전용). 교사 삭제 tombstone이면 로드 거부. */
	async onLoadDocument({ document, documentName, context }) {
		const room = context?.room ?? parseRoom(documentName);
		const claims = context?.claims;
		const row = selectDoc.get({ name: documentName });
		if (!couch || !room || !claims || !isSnapshotTarget(room.dbPath)) {
			if (row?.data) Y.applyUpdate(document, row.data);
			return;
		}
		try {
			const note = await couch.getDoc(claims.d, `note:${room.dbPath}`);
			// 교사 삭제 tombstone: SQLite 잔존 Y-doc까지 지우고 로드 거부 — 삭제된 파일의 방을 다시 열어
			// 옛 상태가 부활하는 것을 막는다(시드 경로의 !deleted 검사는 SQLite 복원 경로를 못 막았다).
			if (isManagerTombstone(note)) {
				deleteDocRow.run({ name: documentName });
				console.log(`[seed] "${documentName}" load refused — note tombstoned by manager`);
				throw new Error("document deleted");
			}
			// 로드 시점의 note 해시를 기억 — 스냅샷 직전 note가 이 값과 다르면 외부 편집(보존 대상).
			if (note && !note.deleted && note.contentHash) lastCouchHash.set(documentName, note.contentHash);
			if (row?.data) {
				Y.applyUpdate(document, row.data);
				// SQLite 복원본은 마지막 세션 시점의 상태다. 그 사이 평문 파일 동기화로 note가
				// 갱신됐다면(다른 기기 deviceId + 내용 불일치) CouchDB note가 정본 — Y.Text를
				// note 내용으로 재시드해, 옛 세션 상태가 최신 편집을 되돌려 덮는 것을 막는다.
				if (note && !note.deleted && typeof note.content === "string") {
					const ytext = document.getText("content");
					const current = ytext.toString();
					const differs = sha256Hex(current) !== (note.contentHash ?? sha256Hex(note.content));
					if (differs && note.lastModifiedDeviceId !== RT_DEVICE_ID) {
						document.transact(() => {
							ytext.delete(0, current.length);
							ytext.insert(0, note.content);
						});
						console.warn(
							`[seed] "${documentName}" persisted Y state was stale — re-seeded from CouchDB note (v${note.version ?? "?"}, last device ${note.lastModifiedDeviceId ?? "?"})`,
						);
					} else if (differs) {
						// 마지막 note가 서버 스냅샷인데 내용이 다르다 = 이전 세션의 마지막 스냅샷이
						// CouchDB에 못 갔다(서버 재시작 등). SQLite가 정본 — 언로드 시 보존 표시.
						sqliteAhead.add(documentName);
					}
				}
				return;
			}
			if (note && !note.deleted && typeof note.content === "string" && note.content.length > 0) {
				// Y.Text 키 "content"는 클라이언트 RealtimeManager.startSession()의 ydoc.getText("content")와 일치해야 한다.
				document.getText("content").insert(0, note.content);
				console.log(`[seed] "${documentName}" seeded from CouchDB note (${note.content.length} chars)`);
			}
		} catch (e) {
			// 시드/검증 실패 시 빈 문서로 열면 스냅샷이 기존 내용을 비울 수 있다 → fail-closed로 연결 거부.
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
		// 여기서부터 CouchDB 반영 전까지는 SQLite가 앞선 상태 — 실패(throw → 디바운서 재시도) 시
		// 표시가 남아 언로드 때 SQLite 행을 보존한다(미반영 편집의 유일한 사본).
		sqliteAhead.add(documentName);

		const content = document.getText("content").toString();
		if (content.length === 0) return; // 빈 내용으로 기존 문서를 덮어쓰지 않음(데이터 손실 방지)
		const contentHash = sha256Hex(content);
		const id = `note:${room.dbPath}`;
		// 조회 실패는 throw → 디바운서가 재시도. (이전엔 null로 폴백해 tombstone 위에 새 문서를 쓸 수 있었다.)
		const existing = await couch.getDoc(claims.d, id);
		// 교사 삭제 tombstone: 스냅샷으로 되살리지 않는다 — SQLite 잔존 상태를 지우고 연결을 닫아 세션 종료.
		if (isManagerTombstone(existing)) {
			deleteDocRow.run({ name: documentName });
			hocuspocusInstance?.closeConnections(documentName);
			console.log(`[snapshot] "${documentName}" skipped — note tombstoned by manager; session closed`);
			return;
		}
		if (existing && !existing.deleted && existing.contentHash === contentHash) {
			sqliteAhead.delete(documentName); // CouchDB가 이미 같은 내용 — 앞섬 해제
			lastCouchHash.set(documentName, contentHash);
			return;
		}

		// 세션 중 외부 편집 보존: note가 서버가 마지막으로 알던 내용과 다르고 새 스냅샷과도 다르면,
		// 비실시간 멤버의 파일 동기화 편집이 끼어든 것이다. Y 문서엔 자동 병합되지 않으므로 그대로
		// 덮으면 유실 — 덮기 전에 버전 문서(kind: conflict)로 보존해 버전 히스토리에서 복구하게 한다.
		const known = lastCouchHash.get(documentName);
		if (
			existing &&
			!existing.deleted &&
			typeof existing.content === "string" &&
			known != null &&
			existing.contentHash !== known &&
			existing.contentHash !== contentHash
		) {
			const ms = nextVersionMs();
			await couch.putDoc(claims.d, {
				_id: `version:${room.dbPath}:${String(ms).padStart(14, "0")}`,
				type: "version",
				schemaVersion: 1,
				workspaceId: claims.c,
				memberId: existing.memberId ?? room.spaceId,
				path: room.dbPath,
				versionOf: existing.version ?? 0,
				content: existing.content,
				contentHash: existing.contentHash,
				kind: "conflict",
				createdAt: new Date(ms).toISOString(),
				createdAtMs: ms,
				createdBy: existing.lastModifiedBy ?? "unknown",
				role: existing.lastModifiedRole ?? "member",
				deviceId: existing.lastModifiedDeviceId ?? "unknown",
			});
			console.warn(
				`[snapshot] "${documentName}" external edit by ${existing.lastModifiedBy ?? "?"} preserved as version (v${existing.version ?? "?"}) before overwrite`,
			);
		}

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
			lastModifiedDeviceId: RT_DEVICE_ID,
			updatedAt: new Date(now).toISOString(),
		});
		sqliteAhead.delete(documentName); // CouchDB 반영 완료 — 이 시점부터 note가 정본
		lastCouchHash.set(documentName, contentHash);
		console.log(`[snapshot] "${documentName}" -> ${claims.d}/${id} (v${(existing?.version ?? 0) + 1})`);
	},

	/** 활성 문서 해제 + 감시 정리. 스냅샷이 CouchDB에 안착했으면 SQLite 행도 지운다(다음 세션은 note에서 시드). */
	async afterUnloadDocument({ documentName }) {
		const info = activeDocs.get(documentName);
		if (!info) return;
		activeDocs.delete(documentName);
		releaseWatcher(info.db);
		lastCouchHash.delete(documentName);
		if (couch && isSnapshotTarget(info.dbPath)) {
			if (sqliteAhead.has(documentName)) {
				// 마지막 스냅샷이 CouchDB에 못 갔다 — SQLite 행이 미반영 편집의 유일한 사본이므로 보존.
				sqliteAhead.delete(documentName);
				console.warn(`[snapshot] "${documentName}" unloaded with CouchDB snapshot pending — keeping SQLite state`);
			} else {
				deleteDocRow.run({ name: documentName });
			}
		}
	},
});

server.listen().then(() => {
	console.log(`CoVault realtime server listening on ws://${host}:${port}`);
	console.log(`  auth: hmac per-member (file-level: ${couch ? "on (CouchDB)" : "OFF — set COUCHDB_URL"})`);
	console.log(`  persistence: SQLite ${sqlitePath}, snapshots: ${couch ? "CouchDB note docs" : "disabled"}`);
});
