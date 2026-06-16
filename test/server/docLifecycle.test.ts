// Hocuspocus 서버 문서 수명주기(onLoad/onStore/unload) — 평가가 "가장 복잡한 정합성 로직인데 무테스트"로
// 지적한 분기 매트릭스를 mock CouchDB·인메모리 SQLite로 검증한다(평가 중기 — 서버 훅 테스트).
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { createDocLifecycle, sha256Hex, RT_DEVICE_ID } from "../../server/hocuspocus/docLifecycle.js";

const CLAIMS = { d: "share_g1", c: "ws", m: "m1", r: "member" };
const ROOM = { dbPath: "모둠활동/토론.md", spaceId: "g1" };
const NAME = "ws/share/g1/모둠활동/토론.md";

/** Y.Doc에 content를 넣고 SQLite에 저장될 형태(상태 업데이트)로 인코딩. */
function encodeState(content: string): Buffer {
	const d = new Y.Doc();
	d.getText("content").insert(0, content);
	return Buffer.from(Y.encodeStateAsUpdate(d));
}

function note(content: string, over: Record<string, unknown> = {}) {
	return {
		_id: `note:${ROOM.dbPath}`,
		_rev: "3-abc",
		type: "note",
		path: ROOM.dbPath,
		content,
		contentHash: sha256Hex(content),
		deleted: false,
		version: 3,
		lastModifiedDeviceId: "client-device",
		...over,
	};
}

/** mock CouchClient + 인메모리 SQLite + 호출 기록. */
function makeEnv(opts: { note?: unknown; getDocError?: boolean; putConflict?: boolean } = {}) {
	const calls = { putDoc: [] as any[], putDocWithRev: [] as any[], closed: [] as string[] };
	const sqliteRows = new Map<string, Buffer>();
	const sqliteMeta = new Map<string, string>();
	let currentNote: unknown = opts.note ?? null; // 세션 사이 외부(파일 동기화) 편집을 흉내내려면 setNote로 교체.
	const couch = {
		async getDoc() {
			if (opts.getDocError) throw new Error("network down");
			return currentNote;
		},
		async putDoc(_db: string, doc: any) {
			calls.putDoc.push(doc);
			return { ok: true };
		},
		async putDocWithRev(_db: string, doc: any, rev: string | undefined) {
			calls.putDocWithRev.push({ doc, rev });
			return opts.putConflict ? "conflict" : "ok";
		},
	};
	const lifecycle = createDocLifecycle({
		couch,
		sqlite: {
			get: (n: string) => sqliteRows.get(n) ?? null,
			put: (n: string, d: Buffer) => void sqliteRows.set(n, d),
			del: (n: string) => void sqliteRows.delete(n),
			getMeta: (k: string) => sqliteMeta.get(k) ?? null,
			putMeta: (k: string, v: string) => void sqliteMeta.set(k, v),
			delMeta: (k: string) => void sqliteMeta.delete(k),
		},
		closeConnections: (n: string) => void calls.closed.push(n),
		log: { log() {}, warn() {}, error() {} },
	});
	return { lifecycle, couch, sqliteRows, sqliteMeta, calls, setNote: (n: unknown) => { currentNote = n; } };
}

describe("onLoadDocument — 시드·재시드 분기 매트릭스", () => {
	it("SQLite 없음 + note 있음 → note 내용으로 시드", async () => {
		const { lifecycle } = makeEnv({ note: note("원격 내용") });
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("원격 내용");
	});

	it("SQLite 없음 + note 없음 → 빈 문서(시드 없음)", async () => {
		const { lifecycle } = makeEnv({});
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("");
	});

	it("SQLite 없음 + 이미 내용 있는 Y.Doc 재시드 → 중복되지 않는다(현장 버그: 전체 내용 반복 덧붙음)", async () => {
		const { lifecycle } = makeEnv({ note: note("원격 내용") });
		// 메모리에 재사용된 Y.Doc이 이미 같은 내용을 갖고 있음(빠른 재접속 등). insert(0)을 무조건 하면 중복된다.
		const document = new Y.Doc();
		document.getText("content").insert(0, "원격 내용");
		await lifecycle.loadDocument({ document, documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("원격 내용"); // "원격 내용원격 내용"이 아니어야 함
	});

	it("SQLite 없음 + 내용이 어긋난 Y.Doc → 정본으로 교체(중복 자체 치유)", async () => {
		const { lifecycle } = makeEnv({ note: note("정본 내용") });
		const document = new Y.Doc();
		document.getText("content").insert(0, "정본 내용정본 내용"); // 과거에 중복된 잔재
		await lifecycle.loadDocument({ document, documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("정본 내용");
	});

	it("교사 삭제 tombstone → SQLite 잔존 행 삭제 + fail-closed(로드 거부)", async () => {
		const { lifecycle, sqliteRows } = makeEnv({ note: note("옛 내용", { deleted: true, deletedByRole: "manager" }) });
		sqliteRows.set(NAME, encodeState("옛 세션 상태"));
		const document = new Y.Doc();
		await expect(
			lifecycle.loadDocument({ document, documentName: NAME, room: ROOM, claims: CLAIMS }),
		).rejects.toThrow("document seed failed");
		expect(sqliteRows.has(NAME)).toBe(false); // 부활 경로 차단
	});

	it("SQLite 복원 + 세션 사이 클라이언트 편집(note가 다른 기기) → note로 재시드(stale 세션이 최신 편집을 덮지 않게)", async () => {
		const { lifecycle, sqliteRows } = makeEnv({ note: note("동기화로 갱신된 내용") });
		sqliteRows.set(NAME, encodeState("옛 세션 상태"));
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("동기화로 갱신된 내용");
	});

	it("SQLite 복원 + note가 서버 스냅샷인데 불일치(직전 스냅샷 미반영) → SQLite가 정본·sqliteAhead 표시", async () => {
		const { lifecycle, sqliteRows } = makeEnv({
			note: note("CouchDB에 못 간 직전 상태 이전 값", { lastModifiedDeviceId: RT_DEVICE_ID }),
		});
		sqliteRows.set(NAME, encodeState("서버 재시작 직전 최신 세션 상태"));
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("서버 재시작 직전 최신 세션 상태");
		expect(lifecycle.sqliteAhead.has(NAME)).toBe(true); // 언로드 시 SQLite 보존
	});

	it("SQLite 복원 + note 일치 → 그대로 복원, lastCouchHash 기억(외부 편집 감지 기준)", async () => {
		const { lifecycle, sqliteRows } = makeEnv({ note: note("같은 내용") });
		sqliteRows.set(NAME, encodeState("같은 내용"));
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("같은 내용");
		expect(lifecycle.lastCouchHash.get(NAME)).toBe(sha256Hex("같은 내용"));
	});

	it("note 조회 실패 → fail-closed(빈 문서로 열어 스냅샷이 내용을 비우는 사고 방지)", async () => {
		const { lifecycle } = makeEnv({ getDocError: true });
		await expect(
			lifecycle.loadDocument({ document: new Y.Doc(), documentName: NAME, room: ROOM, claims: CLAIMS }),
		).rejects.toThrow("document seed failed");
	});

	it("excalidraw + note 조회 실패 → 신선도 검증 불가, SQLite 그대로 복원(가용성 우선)", async () => {
		const { lifecycle, sqliteRows } = makeEnv({ getDocError: true });
		const room = { dbPath: "그림.excalidraw.md", spaceId: "g1" };
		const name = "ws/share/g1/그림.excalidraw.md";
		sqliteRows.set(name, encodeState("씬 상태"));
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: name, room, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("씬 상태");
	});
});

describe("onLoadDocument — Excalidraw 신선도 앵커 (P1-1 #3)", () => {
	const xlRoom = { dbPath: "그림.excalidraw.md", spaceId: "g1" };
	const xlName = "ws/share/g1/그림.excalidraw.md";
	function xlNote(content: string, over: Record<string, unknown> = {}) {
		return { _id: `note:${xlRoom.dbPath}`, type: "note", path: xlRoom.dbPath, content, contentHash: sha256Hex(content), deleted: false, ...over };
	}

	it("SQLite 없음 → 서버는 Y를 적용하지 않고(클라이언트 시드) note 해시를 앵커로 기록", async () => {
		const { lifecycle, sqliteMeta } = makeEnv({ note: xlNote("디스크 그림 v1") });
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: xlName, room: xlRoom, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe(""); // 서버 시드 안 함
		expect(sqliteMeta.get(xlName)).toBe(sha256Hex("디스크 그림 v1"));
	});

	it("앵커 == 현재 note 해시 → SQLite Y 상태 복원(외부 편집 없음)", async () => {
		const { lifecycle, sqliteRows, sqliteMeta } = makeEnv({ note: xlNote("디스크 그림 v1") });
		sqliteRows.set(xlName, encodeState("세션 Y 상태"));
		sqliteMeta.set(xlName, sha256Hex("디스크 그림 v1"));
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: xlName, room: xlRoom, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("세션 Y 상태");
	});

	it("앵커 != 현재 note 해시(세션 사이 외부 편집) → SQLite Y 폐기, 행 삭제, 클라이언트 재시드", async () => {
		const { lifecycle, sqliteRows, sqliteMeta } = makeEnv({ note: xlNote("동기화로 갱신된 그림 v2") });
		sqliteRows.set(xlName, encodeState("옛 세션 Y 상태"));
		sqliteMeta.set(xlName, sha256Hex("디스크 그림 v1")); // 앵커는 v1, 디스크는 v2
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: xlName, room: xlRoom, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe(""); // stale Y 미적용 → 클라이언트가 디스크 v2에서 시드
		expect(sqliteRows.has(xlName)).toBe(false); // stale 행 삭제
		expect(sqliteMeta.get(xlName)).toBe(sha256Hex("동기화로 갱신된 그림 v2")); // 앵커 최신화
	});

	it("앵커 없음(최초 마이그레이션) + SQLite 있음 → 보수적으로 복원하고 앵커 기록", async () => {
		const { lifecycle, sqliteRows, sqliteMeta } = makeEnv({ note: xlNote("디스크 그림") });
		sqliteRows.set(xlName, encodeState("기존 세션 Y 상태"));
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: xlName, room: xlRoom, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("기존 세션 Y 상태");
		expect(sqliteMeta.get(xlName)).toBe(sha256Hex("디스크 그림"));
	});

	it("교사 삭제 tombstone → 로드 거부 + SQLite 행·앵커 삭제(부활 방지)", async () => {
		const { lifecycle, sqliteRows, sqliteMeta } = makeEnv({ note: xlNote("x", { deleted: true, deletedByRole: "manager" }) });
		sqliteRows.set(xlName, encodeState("옛 Y 상태"));
		sqliteMeta.set(xlName, "oldhash");
		await expect(
			lifecycle.loadDocument({ document: new Y.Doc(), documentName: xlName, room: xlRoom, claims: CLAIMS }),
		).rejects.toThrow("document deleted");
		expect(sqliteRows.has(xlName)).toBe(false);
		expect(sqliteMeta.has(xlName)).toBe(false);
	});
});

describe("onStoreDocument — 스냅샷·보존·rev 전제조건", () => {
	function docWith(content: string): Y.Doc {
		const d = new Y.Doc();
		d.getText("content").insert(0, content);
		return d;
	}

	it("기존 note 위에 rev 전제조건 put(version+1, 서버 deviceId) + sqliteAhead 해제", async () => {
		const { lifecycle, calls } = makeEnv({ note: note("이전 내용") });
		await lifecycle.storeDocument({ document: docWith("세션 내용"), documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(calls.putDocWithRev).toHaveLength(1);
		expect(calls.putDocWithRev[0].rev).toBe("3-abc"); // getDoc이 본 rev 위에만(R-C)
		expect(calls.putDocWithRev[0].doc.version).toBe(4);
		expect(calls.putDocWithRev[0].doc.lastModifiedDeviceId).toBe(RT_DEVICE_ID);
		expect(lifecycle.sqliteAhead.has(NAME)).toBe(false);
		expect(lifecycle.lastCouchHash.get(NAME)).toBe(sha256Hex("세션 내용"));
	});

	it("교사 삭제 tombstone이 끼어들면 부활시키지 않고 세션 종료(SQLite 삭제 + closeConnections)", async () => {
		const { lifecycle, sqliteRows, calls } = makeEnv({ note: note("x", { deleted: true, deletedByRole: "manager" }) });
		sqliteRows.set(NAME, encodeState("세션 내용"));
		await lifecycle.storeDocument({ document: docWith("세션 내용"), documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(calls.putDocWithRev).toHaveLength(0); // 부활 없음
		expect(calls.closed).toEqual([NAME]);
		expect(sqliteRows.has(NAME)).toBe(false);
	});

	it("동일 내용이면 put 없이 앞섬만 해제", async () => {
		const { lifecycle, calls } = makeEnv({ note: note("같은 내용") });
		await lifecycle.storeDocument({ document: docWith("같은 내용"), documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(calls.putDocWithRev).toHaveLength(0);
		expect(lifecycle.sqliteAhead.has(NAME)).toBe(false);
	});

	it("세션 중 외부 편집(비실시간 멤버 동기화)은 덮기 전에 version(kind=conflict)으로 보존", async () => {
		const { lifecycle, calls } = makeEnv({
			note: note("외부에서 동기화로 들어온 편집", { lastModifiedBy: "m2", lastModifiedDeviceId: "m2-device" }),
		});
		lifecycle.lastCouchHash.set(NAME, sha256Hex("로드 시점 내용")); // 서버가 마지막으로 알던 값과 다름
		await lifecycle.storeDocument({ document: docWith("세션 내용"), documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(calls.putDoc).toHaveLength(1); // 보존 version 문서
		expect(calls.putDoc[0].kind).toBe("conflict");
		expect(calls.putDoc[0].content).toBe("외부에서 동기화로 들어온 편집");
		expect(calls.putDoc[0].createdBy).toBe("m2");
		expect(calls.putDocWithRev).toHaveLength(1); // 보존 후 스냅샷
	});

	it("rev 충돌(getDoc→put 사이 끼어든 쓰기) → throw로 디바운서 재시도 + sqliteAhead 유지(R-C)", async () => {
		const { lifecycle } = makeEnv({ note: note("이전 내용"), putConflict: true });
		await expect(
			lifecycle.storeDocument({ document: docWith("세션 내용"), documentName: NAME, room: ROOM, claims: CLAIMS }),
		).rejects.toThrow("snapshot rev conflict");
		expect(lifecycle.sqliteAhead.has(NAME)).toBe(true); // 재시도 전까지 SQLite가 유일 사본
	});

	it("빈 내용은 기존 문서를 덮지 않는다(데이터 손실 방지)", async () => {
		const { lifecycle, calls } = makeEnv({ note: note("기존 내용") });
		await lifecycle.storeDocument({ document: new Y.Doc(), documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(calls.putDocWithRev).toHaveLength(0);
	});
});

describe("unload — SQLite Yjs 상태 보존(이력 유지)", () => {
	it("스냅샷이 CouchDB에 안착해도 SQLite 행을 보존(이력 유지로 절전-재접속 중복 방지)", async () => {
		const { lifecycle, sqliteRows } = makeEnv({ note: note("이전") });
		await lifecycle.storeDocument({ document: (() => { const d = new Y.Doc(); d.getText("content").insert(0, "내용"); return d; })(), documentName: NAME, room: ROOM, claims: CLAIMS });
		lifecycle.handleUnload(NAME, ROOM.dbPath);
		expect(sqliteRows.has(NAME)).toBe(true); // 삭제하지 않는다 — 이력 보존
		expect(lifecycle.sqliteAhead.has(NAME)).toBe(false); // 전이 플래그만 해제
	});

	it("CouchDB 미반영(sqliteAhead)이어도 SQLite 행 보존 + 플래그 해제", () => {
		const { lifecycle, sqliteRows } = makeEnv({});
		sqliteRows.set(NAME, encodeState("미반영 편집"));
		lifecycle.sqliteAhead.add(NAME);
		lifecycle.handleUnload(NAME, ROOM.dbPath);
		expect(sqliteRows.has(NAME)).toBe(true);
		expect(lifecycle.sqliteAhead.has(NAME)).toBe(false);
	});

	it("절전 후 재접속 중복 회귀: unload가 이력을 보존해 재접속 클라이언트와 정상 병합(중복 없음)", async () => {
		const { lifecycle } = makeEnv({ note: note("ABC") });
		// 세션 1: 서버가 시드(H1) → 클라이언트(태블릿)가 같은 이력 H1을 받아 보유.
		const server1 = new Y.Doc();
		await lifecycle.loadDocument({ document: server1, documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(server1.getText("content").toString()).toBe("ABC");
		const client = new Y.Doc();
		Y.applyUpdate(client, Y.encodeStateAsUpdate(server1)); // 태블릿 보유분(절전 중에도 메모리 유지)
		await lifecycle.storeDocument({ document: server1, documentName: NAME, room: ROOM, claims: CLAIMS });
		lifecycle.handleUnload(NAME, ROOM.dbPath); // 둘 다 끊김 → unload(이력 보존)

		// 세션 2: 서버 재로드 → 이력 보존이면 같은 H1 복원(새 이력 H2를 시드하지 않음).
		const server2 = new Y.Doc();
		await lifecycle.loadDocument({ document: server2, documentName: NAME, room: ROOM, claims: CLAIMS });
		// 태블릿 잠금 해제 → 보유 H1로 재접속해 양방향 병합.
		Y.applyUpdate(server2, Y.encodeStateAsUpdate(client));
		Y.applyUpdate(client, Y.encodeStateAsUpdate(server2));
		// 이력을 보존하지 않으면 H1↔H2 독립 삽입이 합쳐져 "ABCABC"가 된다. 보존하면 "ABC" 그대로.
		expect(client.getText("content").toString()).toBe("ABC");
		expect(server2.getText("content").toString()).toBe("ABC");
	});

	it("세션 사이 외부 편집으로 재시드돼도, 보존된 이력 위 delete+insert라 재접속 클라이언트가 중복 없이 새 내용으로 수렴", async () => {
		const env = makeEnv({ note: note("ABC") });
		const { lifecycle } = env;
		// 세션 1: 시드 H1="ABC", 클라이언트(태블릿) 보유.
		const server1 = new Y.Doc();
		await lifecycle.loadDocument({ document: server1, documentName: NAME, room: ROOM, claims: CLAIMS });
		const client = new Y.Doc();
		Y.applyUpdate(client, Y.encodeStateAsUpdate(server1));
		await lifecycle.storeDocument({ document: server1, documentName: NAME, room: ROOM, claims: CLAIMS });
		lifecycle.handleUnload(NAME, ROOM.dbPath);

		// 세션 사이 비실시간(파일 동기화) 외부 편집으로 note가 "XYZ"로 바뀜.
		env.setNote(note("XYZ"));

		// 세션 2: 재로드 → SQLite(H1) 복원 후 note와 다름 + non-RT → 제자리 재시드(delete "ABC" + insert "XYZ").
		const server2 = new Y.Doc();
		await lifecycle.loadDocument({ document: server2, documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(server2.getText("content").toString()).toBe("XYZ");
		// 태블릿 재접속: 보유 H1("ABC")이 서버의 delete+insert를 함께 받아 중복 없이 "XYZ"로 수렴.
		Y.applyUpdate(server2, Y.encodeStateAsUpdate(client));
		Y.applyUpdate(client, Y.encodeStateAsUpdate(server2));
		expect(client.getText("content").toString()).toBe("XYZ");
		expect(server2.getText("content").toString()).toBe("XYZ");
	});
});
