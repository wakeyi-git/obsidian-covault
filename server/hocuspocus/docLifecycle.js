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
	 * 실시간 CRDT 상태(Yjs 인코딩)를 CouchDB에 **durable·공유** 영속한다 — `ystate:<dbPath>` 사이드카 문서.
	 *
	 * 중복 누적(ABC→ABCABC)의 근본 원인은 CRDT 이력의 유일한 영속처가 서버 로컬 SQLite뿐이라는 점이었다.
	 * 그 SQLite가 비면(재배포·볼륨 초기화·인스턴스 교체 등) 로드가 note **텍스트**를 새 Yjs 삽입으로 시드하고,
	 * 절전/잠금으로 옛 이력을 메모리에 들고 있던 클라이언트가 재접속하면 같은 글자가 독립 삽입으로 병합돼 전체가
	 * 중복됐다. ystate를 CouchDB에 두면 SQLite 유실 후에도 로드가 `Y.applyUpdate`로 **정확히 같은 이력**을 복원해
	 * 재접속 클라이언트와 무손실 병합한다(서버 인스턴스가 바뀌어도 결정적). 베스트에포트 — 실패해도 note 스냅샷·
	 * 세션을 막지 않는다(다음 store에서 재기록). 클라이언트는 이 문서를 복제하지 않는다(PouchService 복제 필터에서 제외).
	 */
	async function persistYState(document, room, claims, contentHash) {
		if (!couch) return;
		try {
			const state = Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64");
			await couch.putDoc(claims.d, {
				_id: `ystate:${room.dbPath}`,
				type: "ystate",
				schemaVersion: 1,
				workspaceId: claims.c,
				path: room.dbPath,
				state,
				contentHash,
				updatedAt: new Date().toISOString(),
			});
		} catch (e) {
			log.warn(`[ystate] persist failed for "${room.dbPath}": ${e?.message ?? e}`);
		}
	}

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

			// CRDT 이력 복원: ① 로컬 SQLite(가장 신선) → ② 없으면 CouchDB ystate(durable·공유 폴백).
			// 둘 중 하나라도 복원되면 '정확한 같은 이력'이 살아나, 절전/잠금으로 옛 이력을 든 클라이언트가
			// 재접속해도 독립 삽입 병합(중복)이 일어나지 않는다. 둘 다 없을 때만 ③ note 텍스트로 '최초' 시드한다
			// (중복시킬 피어 이력이 애초에 없는 유일한 안전 케이스).
			let restored = false;
			let fromYstate = false;
			if (row) {
				Y.applyUpdate(document, row);
				restored = true;
			} else {
				const ys = await couch.getDoc(claims.d, `ystate:${room.dbPath}`).catch(() => null);
				if (ys && !ys.deleted && typeof ys.state === "string") {
					try {
						Y.applyUpdate(document, Buffer.from(ys.state, "base64"));
						restored = true;
						fromYstate = true;
					} catch (e) {
						log.warn(`[seed] "${documentName}" ystate decode failed: ${e?.message ?? e} — falling back to text seed`);
					}
				}
			}

			if (restored) {
				// 복원된 이력이 현재 note와 다르면 note로 수렴시킨다. 수렴 조건:
				//  - ystate 복원: ystate 증분 쓰기가 note보다 지연/실패했을 수 있어(둘은 같은 store에서 기록되나
				//    네트워크 독립) note가 더 신선할 수 있으므로 **항상** 수렴.
				//  - SQLite 복원: 세션 사이 비실시간(파일 동기화) 외부 편집(non-RT deviceId)일 때만 수렴. 그 외
				//    note가 서버 스냅샷인데 다르면 SQLite가 정본(직전 스냅샷 미반영) — ahead로 보존.
				// 어느 경우든 '보존된 이력 위 delete+insert'라 재접속 클라이언트와 중복 없이 수렴한다.
				if (note && !note.deleted && typeof note.content === "string" && note.content.length > 0) {
					const ytext = document.getText("content");
					const current = ytext.toString();
					const differs = sha256Hex(current) !== (note.contentHash ?? sha256Hex(note.content));
					if (differs && (fromYstate || note.lastModifiedDeviceId !== RT_DEVICE_ID)) {
						document.transact(() => {
							ytext.delete(0, current.length);
							ytext.insert(0, note.content);
						});
						log.warn(
							`[seed] "${documentName}" restored ${fromYstate ? "ystate" : "SQLite"} differed from note — re-seeded from CouchDB note (v${note.version ?? "?"}, last device ${note.lastModifiedDeviceId ?? "?"})`,
						);
						// 재시드 결과를 durable 저장에 반영한다. 안 하면 저장본은 재시드 전 이력으로 남아, (편집이 없어
						// onStoreDocument가 안 불리는 한) 다음 재로드마다 같은 내용을 매번 '새 ID'로 재시드해 — 재접속
						// 클라이언트가 이전 재시드본과 독립 병합 → "XYZXYZ"로 누적된다. 갱신하면 다음 재로드가 같은
						// 이력을 복원해 재시드 자체가 사라진다(differs=false).
						sqlite.put(documentName, Buffer.from(Y.encodeStateAsUpdate(document)));
						await persistYState(document, room, claims, note.contentHash ?? sha256Hex(note.content));
					} else if (differs) {
						sqliteAhead.add(documentName);
					}
				}
				return;
			}

			if (note && !note.deleted && typeof note.content === "string" && note.content.length > 0) {
				// Y.Text 키 "content"는 클라이언트 RealtimeManager.startSession()의 ydoc.getText("content")와 일치해야 한다.
				// ⚠️ insert(0)을 무조건 하면, 메모리에 재사용된 Y.Doc(빠른 재접속 등)에 이미 내용이 있을 때
				// 전체 내용이 한 번 더 붙어 **중복**된다(노트 전체가 끝에 반복적으로 덧붙는 현장 버그). 그래서
				// 빈 경우에만 시드하고, 어쩌다 내용이 남아 있으면 정본(note.content)으로 **교체**해 멱등하게 만든다
				// (중복 상태도 자체 치유). 교체 패턴은 위 재시드(differs)와 동일.
				const ytext = document.getText("content");
				const current = ytext.toString();
				if (current !== note.content) {
					document.transact(() => {
						if (current.length > 0) ytext.delete(0, current.length);
						ytext.insert(0, note.content);
					});
					log.log(
						`[seed] "${documentName}" seeded from CouchDB note (${note.content.length} chars${current.length > 0 ? `, replaced ${current.length} stale` : ""})`,
					);
				}
				// ⭐ 시드 이력을 **즉시** durable 영속한다. 시드는 onLoadDocument 안에서 일어나 onStoreDocument를
				// 발화시키지 않으므로(편집이 한 번도 없으면 store가 영영 안 불린다), 이걸 안 하면 방이 unload된 뒤
				// 재접속이 같은 내용을 '새 이력'으로 다시 시드해 — 직전 시드 이력(H1)을 그대로 든 클라이언트와 독립
				// 병합 → 노트 전체 중복(현장 재발: 편집 없이 열어둔 노트가 절전-재접속으로 ABCABC). 시드 시점에
				// SQLite·ystate를 써두면 재로드가 같은 H1을 복원해 재시드가 일어나지 않는다.
				sqlite.put(documentName, Buffer.from(Y.encodeStateAsUpdate(document)));
				await persistYState(document, room, claims, note.contentHash ?? sha256Hex(note.content));
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
				await persistYState(document, room, claims, contentHash); // 같은 내용이라도 CRDT 이력은 영속(기존 노트 ystate 부트스트랩)
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
			await persistYState(document, room, claims, contentHash); // note 스냅샷과 함께 CRDT 이력도 durable 영속(SQLite 유실 대비)
			noteCouchOk();
			log.log(`[snapshot] "${documentName}" -> ${claims.d}/${id} (v${(existing?.version ?? 0) + 1})`);
		} catch (e) {
			noteCouchFail(e); // 헬스 엔드포인트에 실패 누적 노출 — throw는 유지(디바운서 재시도)
			throw e;
		}
	}

	/**
	 * 언로드: SQLite의 Yjs 상태(=CRDT 이력)를 **보존**한다(전이 플래그만 해제).
	 *
	 * 예전엔 CouchDB 스냅샷이 안착하면 SQLite 행을 지웠다. 그러면 다음 로드가 CouchDB 내용으로 **새 이력**을
	 * 시드하는데, 잠금/절전으로 옛 이력을 메모리에 들고 있던 클라이언트가 재접속하면 같은 내용이 서로 독립적인
	 * 삽입으로 병합돼 **노트 전체가 중복**된다(현장 버그: 절전 후 세션 재접속 시 누적). 이력을 보존하면 재로드가
	 * `Y.applyUpdate`로 같은 이력을 복원해 클라이언트와 정상 병합된다(중복 없음). 세션 사이 외부(파일 동기화)
	 * 편집은 loadDocument의 신선도 검사가 그때만 재시드하므로 정합성은 유지된다.
	 */
	function handleUnload(documentName) {
		lastCouchHash.delete(documentName);
		sqliteAhead.delete(documentName);
	}

	return { loadDocument, storeDocument, handleUnload, sqliteAhead, lastCouchHash };
}
