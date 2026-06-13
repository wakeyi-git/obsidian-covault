// 유령 충돌(모든 리프=라이브 동일) 자동 정리. 충돌 카운트는 _conflicts 존재만 보고
// 충돌 목록은 내용 차이가 있는 리프만 보여줘서, 둘이 영원히 어긋나던 문제의 회귀 테스트.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { noteId } from "../../src/core/model/types";

describe("유령 충돌 자동 정리 (collapseIdentical)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	/** 양쪽이 같은 최종 내용으로 분기 편집 → _conflicts는 있지만 모든 리프가 라이브와 동일. */
	async function makePhantom(a: ReturnType<Cluster["device"]>, b: ReturnType<Cluster["device"]>, path: string): Promise<void> {
		a.vault.seed(path, "base");
		await a.uploader.uploadPath(path);
		await a.push();
		await b.pull();

		// b: 1회 편집(gen2, "same"). 푸시하지 않음.
		b.vault.seed(path, "same");
		await b.uploader.uploadPath(path);

		// a: 2회 편집(gen3)으로 승자를 a쪽으로 — 최종 내용은 b와 같은 "same".
		a.vault.seed(path, "mid");
		await a.uploader.uploadPath(path);
		a.vault.seed(path, "same");
		await a.uploader.uploadPath(path);
		await a.push();
		await b.pull();
	}

	it("목록을 열면 유령 충돌은 표시 없이 리프가 정리되고 집계에서도 빠진다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		await makePhantom(a, b, "p.md");
		const id = noteId("p.md");
		const before = await b.ctx.pouch.getWithConflicts<{ _conflicts?: string[] }>(id);
		expect(before?._conflicts?.length).toBeGreaterThan(0); // 유령 충돌 존재(카운트가 세는 상태)
		b.ctx.conflictIds.add(id); // 증분 집계가 세고 있던 상황 재현

		const rows = await b.conflicts.list();
		expect(rows).toHaveLength(0); // 목록에는 없고
		const after = await b.ctx.pouch.getWithConflicts<{ _conflicts?: string[] }>(id);
		expect(after?._conflicts ?? []).toHaveLength(0); // 리프는 collapse
		expect(b.ctx.conflictIds.has(id)).toBe(false); // 카운트 집계도 해제
		expect(b.vault.textOf("p.md")).toBe("same"); // 라이브 내용은 그대로
	});

	it("내용이 다른 진짜 충돌은 정리하지 않고 그대로 나열한다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		// 공통 조상 후 서로 다른 내용으로 분기
		a.vault.seed("r.md", "base");
		await a.uploader.uploadPath("r.md");
		await a.push();
		await b.pull();
		b.vault.seed("r.md", "B-edit");
		await b.uploader.uploadPath("r.md");
		a.vault.seed("r.md", "A-edit1");
		await a.uploader.uploadPath("r.md");
		a.vault.seed("r.md", "A-edit2");
		await a.uploader.uploadPath("r.md");
		await a.push();
		await b.pull();

		const rows = await b.conflicts.list();
		expect(rows).toHaveLength(1);
		expect(rows[0].dbPath).toBe("r.md");
		const doc = await b.ctx.pouch.getWithConflicts<{ _conflicts?: string[] }>(noteId("r.md"));
		expect(doc?._conflicts?.length).toBeGreaterThan(0); // 진짜 충돌은 유지
	});
});
