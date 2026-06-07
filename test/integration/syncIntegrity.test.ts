// 동기화 정합성 회귀 테스트: LocalApplier 체크포인트(P0-1), tombstone 고아 사본 정리(P1#2),
// syncAssets off 비대칭(P1#4). 실제 엔진 + 인메모리 vault/PouchDB로 검증.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { LocalApplier } from "../../src/core/sync/LocalApplier";
import { noteId } from "../../src/core/model/types";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("LocalApplier 체크포인트 (P0-1)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("적용 실패가 나면 그 지점 이후로 lastSeq를 전진시키지 않는다", async () => {
		cluster = new Cluster();
		const d = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });

		// 로컬 DB에 노트 2건(good → bad 순서로 seq 부여).
		d.vault.seed("good.md", "1");
		await d.uploader.uploadPath("good.md");
		d.vault.seed("bad.md", "2");
		await d.uploader.uploadPath("bad.md");

		// bad.md 적용에서만 실패하는 스텁 applier.
		let resolveSeen: () => void;
		const seenBad = new Promise<void>((r) => (resolveSeen = r));
		const stub = {
			applyDoc: async (doc: any) => {
				if (doc.path === "bad.md") {
					resolveSeen();
					throw new Error("boom");
				}
			},
			applyAsset: async () => {},
			applyPurge: async () => {},
		};
		const la = new LocalApplier(d.ctx, stub as any);
		la.start();
		await seenBad;
		await tick(); // catch + 체크포인트 로직 한 틱 더

		const last = Number(d.ctx.getLastSeq());
		const head = Number(await d.ctx.pouch.currentLocalSeq());
		la.stop();

		expect(last).toBeGreaterThan(0); // good.md는 적용·체크포인트됨
		expect(last).toBeLessThan(head); // bad.md(이후)는 체크포인트되지 않음 → 재시작 시 재처리
	});
});

describe("tombstone 적용 시 고아 사본 정리 (P1 #2)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("삭제를 적용하면 _충돌/ 원격본·내편집 백업도 함께 제거된다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("c.md", "base");
		await a.uploader.uploadPath("c.md");
		await a.push();
		await b.pull();

		// b 쪽에 충돌 보류본 + 내편집 백업이 남아 있는 상황을 만든다(고아 사본).
		const conflictPath = b.ctx.conflictLocalPath("c.md");
		const backupPath = b.ctx.localBackupPath("c.md");
		b.vault.seed(conflictPath, "remote-leftover");
		b.vault.seed(backupPath, "my-edit");
		expect(b.vault.has(conflictPath)).toBe(true);
		expect(b.vault.has(backupPath)).toBe(true);

		// a가 파일을 삭제 → b가 tombstone 수신·적용.
		await a.uploader.tombstonePath("c.md");
		await a.push();
		await b.pull();
		const del = await b.ctx.pouch.getWithConflicts<any>(noteId("c.md"));
		expect(del?.deleted).toBe(true);
		await b.applier.applyDoc(del);

		// 고아 사본이 정리되어야 한다.
		expect(b.vault.has(conflictPath)).toBe(false);
		expect(b.vault.has(backupPath)).toBe(false);
	});
});

describe("syncAssets off 대칭 (P1 #4)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("첨부 동기화를 끈 기기는 첨부 tombstone을 적용하지 않는다(로컬 첨부 보존)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1", settings: { syncAssets: false } });

		const data = new TextEncoder().encode("PNG").buffer;
		a.vault.seedBinary("p.png", data);
		await a.uploader.uploadPath("p.png");
		await a.push();

		// b(첨부 off)에는 예전부터 로컬 첨부가 있다고 가정.
		b.vault.seedBinary("p.png", data);
		await b.pull(); // asset tombstone 수신은 되지만 적용은 막혀야 함

		await a.uploader.tombstonePath("p.png");
		await a.push();
		await b.pull();
		const del = await b.asset("p.png");
		expect(del?.deleted).toBe(true);

		const result = await b.applier.applyAsset(del as any);
		expect(result).toBe("skipped-nonmd"); // 첨부 off → 일절 처리하지 않음(삭제 포함)
		expect(b.vault.has("p.png")).toBe(true); // 로컬 첨부 보존
	});
});
