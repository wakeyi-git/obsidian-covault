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
	const couch = {
		async getDoc() {
			if (opts.getDocError) throw new Error("network down");
			return opts.note ?? null;
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
		},
		closeConnections: (n: string) => void calls.closed.push(n),
		log: { log() {}, warn() {}, error() {} },
	});
	return { lifecycle, couch, sqliteRows, calls };
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

	it("excalidraw(비스냅샷 대상)는 CouchDB를 보지 않고 SQLite만 복원", async () => {
		const { lifecycle, sqliteRows } = makeEnv({ getDocError: true }); // couch를 보면 throw
		const room = { dbPath: "그림.excalidraw.md", spaceId: "g1" };
		const name = "ws/share/g1/그림.excalidraw.md";
		sqliteRows.set(name, encodeState("씬 상태"));
		const document = new Y.Doc();
		await lifecycle.loadDocument({ document, documentName: name, room, claims: CLAIMS });
		expect(document.getText("content").toString()).toBe("씬 상태");
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

describe("unload — SQLite 행 보존/정리", () => {
	it("스냅샷이 CouchDB에 안착했으면 SQLite 행 삭제(다음 세션은 note에서 시드)", async () => {
		const { lifecycle, sqliteRows, calls } = makeEnv({ note: note("이전") });
		await lifecycle.storeDocument({ document: (() => { const d = new Y.Doc(); d.getText("content").insert(0, "내용"); return d; })(), documentName: NAME, room: ROOM, claims: CLAIMS });
		expect(calls.putDocWithRev).toHaveLength(1);
		lifecycle.handleUnload(NAME, ROOM.dbPath);
		expect(sqliteRows.has(NAME)).toBe(false);
	});

	it("CouchDB 미반영(sqliteAhead)이면 SQLite 행 보존 — 미반영 편집의 유일한 사본", () => {
		const { lifecycle, sqliteRows } = makeEnv({});
		sqliteRows.set(NAME, encodeState("미반영 편집"));
		lifecycle.sqliteAhead.add(NAME);
		lifecycle.handleUnload(NAME, ROOM.dbPath);
		expect(sqliteRows.has(NAME)).toBe(true);
		expect(lifecycle.sqliteAhead.has(NAME)).toBe(false);
	});
});
