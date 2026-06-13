/**
 * 문서 수명주기(로드 시드·스냅샷·언로드) — server.js의 onLoadDocument/onStoreDocument/afterUnloadDocument
 * 핵심 로직을 의존성 주입으로 분리한 모듈(평가 중기 — 서버 훅 테스트). SQLite·CouchDB·연결 종료를
 * deps로 받아 vitest에서 mock으로 검증한다. 동작은 server.js에 있던 코드와 동일해야 한다.
 */
import * as Y from "yjs";
import crypto from "crypto";

/** 서버 스냅샷의 deviceId — note가 이 값이 아니면 마지막 변경은 클라이언트(파일 동기화)에서 왔다. */
export const RT_DEVICE_ID = "covault-rt-server";

/** 교사 삭제 tombstone 여부 — 교사 삭제는 실시간 세션·스냅샷보다 우선한다(부활 방지). 구성원 삭제는 세션 보호가 우선. */
export function isManagerTombstone(note) {
	return !!note?.deleted && note.deletedByRole === "manager";
}

export function sha256Hex(s) {
	return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** CouchDB 스냅샷/시드 대상: 마크다운 문서만. .excalidraw.md는 클라이언트가 세션 종료 시 저장한다. */
export function isSnapshotTarget(dbPath) {
	const lower = dbPath.toLowerCase();
	return lower.endsWith(".md") && !lower.endsWith(".excalidraw.md");
}

/** 버전 문서 id용 단조 증가 타임스탬프(같은 ms 충돌 방지) — 클라이언트 VersionStore와 동형. */
let lastVersionMs = 0;
function nextVersionMs() {
	lastVersionMs = Math.max(Date.now(), lastVersionMs + 1);
	return lastVersionMs;
}

/**
 * deps:
 *  - couch: CouchClient | null (getDoc/putDoc/putDocWithRev)
 *  - sqlite: { get(name): Buffer|null, put(name, Buffer), del(name) }
 *  - closeConnections(documentName): 교사 tombstone 감지 시 세션 종료
 *  - noteCouchOk()/noteCouchFail(e): 헬스 카운터(선택)
 *  - log: console 호환(선택)
 */
export function createDocLifecycle(deps) {
	const { couch, sqlite, closeConnections, noteCouchOk = () => {}, noteCouchFail = () => {}, log = console } = deps;

	/** SQLite가 CouchDB 스냅샷보다 앞서 있는 문서 — 언로드 시 SQLite 행 보존 판단(데이터 유실 방지). */
	const sqliteAhead = new Set();
	/** 서버가 마지막으로 확인/기록한 CouchDB note의 contentHash — 세션 중 외부 편집 감지. */
	const lastCouchHash = new Map();

	/**
	 * Excalidraw(.excalidraw.md) 로드: 서버는 excalidraw를 CouchDB 스냅샷하지 않아 Y 상태→파일 해시를
	 * 만들 수 없다(마크다운의 contentHash 재시드 가드 불가). 대신 CouchDB note(파일 동기화본)의 contentHash를
	 * 앵커(covault_meta)에 저장해 두고, 세션 사이 비실시간(파일 동기화) 편집으로 note가 바뀌면 SQLite Y 상태를
	 * stale로 보고 **버린다** → 클라이언트가 현재 디스크 씬에서 다시 시드(seedElection). 평가 P1-1 #3.
	 *
	 * 정상 세션 종료(클라이언트가 새 본을 업로드)도 note 해시를 바꾸므로, 다음 세션이 한 번 더 재시드할 수
	 * 있으나 무해하다(현재 디스크 = 그 세션의 최종 씬이므로 같은 내용으로 재시드). 데이터 유실 방지가 우선.
	 * note 조회 실패 시엔 신선도 검증을 못 하므로 SQLite를 그대로 복원한다(가용성 우선 — 빈 문서가 디스크를
	 * 덮을 위험은 클라이언트 빈-내용 가드가 막는다).
	 */
	async function loadExcalidraw({ document, documentName, room, claims, row }) {
		let note;
		try {
			note = await couch.getDoc(claims.d, `note:${room.dbPath}`);
		} catch (e) {
			log.warn(`[seed] excalidraw note lookup failed for "${documentName}": ${e?.message ?? e} — restoring SQLite as-is`);
			if (row) Y.applyUpdate(document, row);
			return;
		}
		// 교사 삭제 tombstone: 마크다운과 동일하게 SQLite·앵커를 지우고 로드 거부(부활 방지).
		if (isManagerTombstone(note)) {
			sqlite.del(documentName);
			sqlite.delMeta?.(documentName);
			log.log(`[seed] "${documentName}" load refused — excalidraw note tombstoned by manager`);
			throw new Error("document deleted");
		}
		const noteHash = note && !note.deleted ? note.contentHash ?? null : null;
		if (!row) {
			// SQLite 없음 → 클라이언트가 디스크 씬에서 시드한다(서버는 excalidraw Y를 시드하지 않는다).
			// 현재 note 해시를 앵커로 남겨, 다음 세션이 외부 편집을 감지하게 한다.
			if (noteHash) sqlite.putMeta?.(documentName, noteHash);
			return;
		}
		const anchor = sqlite.getMeta?.(documentName) ?? null;
		if (noteHash && anchor && anchor !== noteHash) {
			// 세션 사이 외부(파일 동기화) 편집으로 디스크 그림이 바뀜 → SQLite Y 상태는 stale. 적용하지 않고 버린다.
			sqlite.del(documentName);
			sqlite.putMeta?.(documentName, noteHash);
			log.warn(`[seed] "${documentName}" excalidraw SQLite state stale (disk note changed) — discarded; client will re-seed`);
			return;
		}
		Y.applyUpdate(document, row);
		if (noteHash) sqlite.putMeta?.(documentName, noteHash);
	}

	/** 문서 로드: SQLite 복원 → 없으면 CouchDB note 문서로 시드(마크다운 전용). 교사 삭제 tombstone이면 로드 거부. */
	async function loadDocument({ document, documentName, room, claims }) {
		const row = sqlite.get(documentName);
		if (!couch || !room || !claims) {
			if (row) Y.applyUpdate(document, row);
			return;
		}
		if (!isSnapshotTarget(room.dbPath)) {
			await loadExcalidraw({ document, documentName, room, claims, row });
			return;
		}
		try {
			const note = await couch.getDoc(claims.d, `note:${room.dbPath}`);
			// 교사 삭제 tombstone: SQLite 잔존 Y-doc까지 지우고 로드 거부 — 삭제된 파일의 방을 다시 열어
			// 옛 상태가 부활하는 것을 막는다(시드 경로의 !deleted 검사는 SQLite 복원 경로를 못 막았다).
			if (isManagerTombstone(note)) {
				sqlite.del(documentName);
				log.log(`[seed] "${documentName}" load refused — note tombstoned by manager`);
				throw new Error("document deleted");
			}
			// 로드 시점의 note 해시를 기억 — 스냅샷 직전 note가 이 값과 다르면 외부 편집(보존 대상).
			if (note && !note.deleted && note.contentHash) lastCouchHash.set(documentName, note.contentHash);
			if (row) {
				Y.applyUpdate(document, row);
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
						log.warn(
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
				log.log(`[seed] "${documentName}" seeded from CouchDB note (${note.content.length} chars)`);
			}
		} catch (e) {
			// 시드/검증 실패 시 빈 문서로 열면 스냅샷이 기존 내용을 비울 수 있다 → fail-closed로 연결 거부.
			log.error(`[seed] failed for "${documentName}": ${e?.message ?? e}`);
			throw new Error("document seed failed");
		}
	}

	/**
	 * 문서 저장(디바운스): SQLite 영속화 + 마크다운이면 CouchDB note 스냅샷.
	 * throw 시 Hocuspocus v4가 디바운서에 남겨 재시도하며, 종료 시 pending store를 flush한다.
	 */
	async function storeDocument({ document, documentName, room, claims }) {
		sqlite.put(documentName, Buffer.from(Y.encodeStateAsUpdate(document)));

		if (!couch || !room || !claims || !isSnapshotTarget(room.dbPath)) return;
		// 여기서부터 CouchDB 반영 전까지는 SQLite가 앞선 상태 — 실패(throw → 디바운서 재시도) 시
		// 표시가 남아 언로드 때 SQLite 행을 보존한다(미반영 편집의 유일한 사본).
		sqliteAhead.add(documentName);

		const content = document.getText("content").toString();
		if (content.length === 0) return; // 빈 내용으로 기존 문서를 덮어쓰지 않음(데이터 손실 방지)
		const contentHash = sha256Hex(content);
		const id = `note:${room.dbPath}`;
		try {
			// 조회 실패는 throw → 디바운서가 재시도. (이전엔 null로 폴백해 tombstone 위에 새 문서를 쓸 수 있었다.)
			const existing = await couch.getDoc(claims.d, id);
			// 교사 삭제 tombstone: 스냅샷으로 되살리지 않는다 — SQLite 잔존 상태를 지우고 연결을 닫아 세션 종료.
			if (isManagerTombstone(existing)) {
				sqlite.del(documentName);
				closeConnections?.(documentName);
				log.log(`[snapshot] "${documentName}" skipped — note tombstoned by manager; session closed`);
				noteCouchOk();
				return;
			}
			if (existing && !existing.deleted && existing.contentHash === contentHash) {
				sqliteAhead.delete(documentName); // CouchDB가 이미 같은 내용 — 앞섬 해제
				lastCouchHash.set(documentName, contentHash);
				noteCouchOk();
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
				log.warn(
					`[snapshot] "${documentName}" external edit by ${existing.lastModifiedBy ?? "?"} preserved as version (v${existing.version ?? "?"}) before overwrite`,
				);
			}

			const now = Date.now();
			// rev 전제조건 put(평가 R-C): getDoc(existing)→put 사이에 끼어든 쓰기(교사 tombstone·외부
			// 멤버 편집)를 LWW로 덮지 않는다. 충돌이면 throw → 디바운서 재시도가 위의 전제조건 검사
			// (tombstone 스킵·외부 편집 버전 보존)를 처음부터 다시 수행한다. sqliteAhead 표시가 남아
			// 재시도 전까지 SQLite가 미반영 편집을 보존한다.
			const putRes = await couch.putDocWithRev(
				claims.d,
				{
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
				},
				existing?._rev,
			);
			if (putRes === "conflict") {
				throw new Error(`snapshot rev conflict on ${claims.d}/${id} — will retry with fresh preconditions`);
			}
			sqliteAhead.delete(documentName); // CouchDB 반영 완료 — 이 시점부터 note가 정본
			lastCouchHash.set(documentName, contentHash);
			noteCouchOk();
			log.log(`[snapshot] "${documentName}" -> ${claims.d}/${id} (v${(existing?.version ?? 0) + 1})`);
		} catch (e) {
			noteCouchFail(e); // 헬스 엔드포인트에 실패 누적 노출 — throw는 유지(디바운서 재시도)
			throw e;
		}
	}

	/** 언로드: 스냅샷이 CouchDB에 안착했으면 SQLite 행 삭제, 앞서 있으면 보존(미반영 편집의 유일한 사본). */
	function handleUnload(documentName, dbPath) {
		lastCouchHash.delete(documentName);
		if (couch && isSnapshotTarget(dbPath)) {
			if (sqliteAhead.has(documentName)) {
				// 마지막 스냅샷이 CouchDB에 못 갔다 — SQLite 행이 미반영 편집의 유일한 사본이므로 보존.
				sqliteAhead.delete(documentName);
				log.warn(`[snapshot] "${documentName}" unloaded with CouchDB snapshot pending — keeping SQLite state`);
			} else {
				sqlite.del(documentName);
			}
		}
	}

	return { loadDocument, storeDocument, handleUnload, sqliteAhead, lastCouchHash };
}
