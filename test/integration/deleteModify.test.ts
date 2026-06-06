// Phase 3: 최근 영구 삭제 되돌리기 + 삭제/수정 충돌 큐 — 실제 엔진으로 검증.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { RestoreManager } from "../../src/core/sync/RestoreManager";

describe("최근 영구 삭제 되돌리기", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("노트 purge 후 스냅샷에서 되돌리기", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });
		const r = new RestoreManager(dev.ctx, dev.uploader);

		dev.vault.seed("a.md", "important");
		await dev.uploader.uploadPath("a.md");
		await dev.uploader.tombstonePath("a.md"); // content는 tombstone에 보존
		await dev.vault.delete(dev.vault.getAbstractFileByPath("a.md") as any); // 원본 부재(보관 폴더에서 삭제된 상황)
		await r.purge("a.md"); // 영구 삭제(+스냅샷 기록)
		expect(await dev.note("a.md")).toBeNull();

		const purges = await r.listRecentPurges();
		const snap = purges.find((p) => p.dbPath === "a.md");
		expect(snap?.recoverable).toBe(true);

		expect(await r.undoPurge(snap!.id)).toBe("restored");
		expect((await dev.note("a.md"))?.deleted).toBe(false);
		expect((await dev.note("a.md"))?.content).toBe("important");
		expect(dev.vault.textOf("a.md")).toBe("important");
		// 되돌린 항목은 목록에서 사라진다.
		expect((await r.listRecentPurges()).some((p) => p.dbPath === "a.md")).toBe(false);
	});
});

describe("삭제/수정 충돌 큐", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	async function setupConflict() {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("x.md", "v1");
		await a.sync("both"); // 기준선

		await b.pull();
		b.vault.seed("x.md", "v2");
		await b.uploader.uploadPath("x.md");
		await b.push();

		await a.pull(); // a 로컬 rev R1→R2
		const x = a.vault.getAbstractFileByPath("x.md");
		await a.vault.delete(x as any); // 오프라인 삭제
		await a.sync("both"); // reconcile → 삭제/수정 충돌 기록(보존)
		return { a, r: new RestoreManager(a.ctx, a.uploader) };
	}

	it("rev 불일치로 보존된 항목이 큐에 기록된다", async () => {
		const { r } = await setupConflict();
		const q = await r.listDeleteModify();
		expect(q.map((e) => e.dbPath)).toContain("x.md");
	});

	it("'내 삭제 적용' → tombstone + 큐에서 제거", async () => {
		const { a, r } = await setupConflict();
		await r.resolveDeleteModify("x.md", "delete");
		expect((await a.note("x.md"))?.deleted).toBe(true);
		expect((await r.listDeleteModify()).some((e) => e.dbPath === "x.md")).toBe(false);
	});

	it("'원격 수정 유지' → 큐에서만 제거(문서는 그대로)", async () => {
		const { a, r } = await setupConflict();
		await r.resolveDeleteModify("x.md", "keep-remote");
		expect((await a.note("x.md"))?.deleted).toBe(false);
		expect((await r.listDeleteModify()).some((e) => e.dbPath === "x.md")).toBe(false);
	});

	it("P1: localRoot 있는 링크에서 '수정본 보관 후 삭제'가 복사본을 만든다", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "t", role: "manager", remoteDb: "mirror_alice", localRoot: "members/alice" });
		const r = new RestoreManager(dev.ctx, dev.uploader);

		// 학생 폴더 아래 노트(dbPath="과제.md", localPath="members/alice/과제.md")
		dev.vault.seed("members/alice/과제.md", "remote-edited");
		await dev.uploader.uploadPath("members/alice/과제.md");

		await r.resolveDeleteModify("과제.md", "keep-both");

		// 복사본이 localRoot 아래에 생성되고, DB에도 그 dbPath로 존재해야 한다.
		expect(dev.vault.textOf("members/alice/과제.원격수정.md")).toBe("remote-edited");
		expect(await dev.note("과제.원격수정.md")).toBeTruthy();
		// 원본은 tombstone.
		expect((await dev.note("과제.md"))?.deleted).toBe(true);
	});

	it("P1(asset): localRoot 있는 링크에서 첨부 '수정본 보관 후 삭제'가 복사본을 만든다", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "t", role: "manager", remoteDb: "mirror_alice", localRoot: "members/alice" });
		const r = new RestoreManager(dev.ctx, dev.uploader);

		const data = new TextEncoder().encode("PNGDATA").buffer;
		dev.vault.seedBinary("members/alice/img/p.png", data); // dbPath="img/p.png"
		await dev.uploader.uploadPath("members/alice/img/p.png");

		await r.resolveDeleteModify("img/p.png", "keep-both");

		// 복사본이 localRoot 아래에 생성되고 DB에도 그 dbPath로 존재해야 한다.
		expect(dev.vault.has("members/alice/img/p.원격수정.png")).toBe(true);
		expect(await dev.asset("img/p.원격수정.png")).toBeTruthy();
		expect((await dev.asset("img/p.png"))?.deleted).toBe(true);
	});
});
