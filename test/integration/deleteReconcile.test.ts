// P1 시나리오 1·2: 삭제 정합의 안전성.
// 보고서 권장: 신규/빈 vault에서 서버 문서가 삭제로 오판되지 않는지 / 오프라인 삭제가 manifest 기준으로만 tombstone 되는지.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { listDeleteModify } from "../../src/core/sync/deleteModifyQueue";

describe("삭제 정합 (delete reconcile)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("시나리오1: 신규/빈 vault 전체 동기화는 원격 문서를 tombstone하지 않는다(기준선 없음)", async () => {
		cluster = new Cluster();
		const manager = cluster.device({ deviceId: "t", role: "manager", remoteDb: "mirror_s1" });
		const fresh = cluster.device({ deviceId: "fresh", role: "member", remoteDb: "mirror_s1" });
		const observer = cluster.device({ deviceId: "obs", role: "member", remoteDb: "mirror_s1" });

		for (const p of ["a.md", "b.md", "c.md"]) manager.vault.seed(p, `content-${p}`);
		await manager.sync("up");

		// 빈 vault(기준선 manifest 없음)에서 양방향 전체 동기화
		await fresh.sync("both");

		// 받은 파일은 vault로 내려와야 하고
		for (const p of ["a.md", "b.md", "c.md"]) expect(fresh.vault.has(p)).toBe(true);

		// 원격 문서는 어느 것도 삭제로 오판되지 않아야 한다(observer가 원격을 pull해 확인).
		await observer.pull();
		for (const p of ["a.md", "b.md", "c.md"]) {
			expect((await observer.note(p))?.deleted).toBe(false);
		}
	});

	it("시나리오1b: 기준선이 있어도 대량 소실(폴더 오설정 추정)이면 tombstone 중단·경고", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });

		const paths = Array.from({ length: 12 }, (_, i) => `n${i}.md`);
		for (const p of paths) dev.vault.seed(p, `c-${p}`);
		await dev.sync("both"); // 기준선(12개) 기록

		// 모든 파일이 사라진 상태(예: localRoot 오설정) — 직접 vault에서 제거
		for (const p of paths) {
			const f = dev.vault.getAbstractFileByPath(p);
			if (f) await dev.vault.delete(f as any);
		}

		await dev.sync("both");

		// 임계치 초과 → 어떤 문서도 tombstone되지 않아야 한다.
		for (const p of paths) expect((await dev.note(p))?.deleted).toBe(false);
		expect(dev.warnings().some((m) => m.includes("삭제 정합 중단"))).toBe(true);
	});

	it("시나리오2: 오프라인 단일 삭제는 다음 동기화에서 정확히 그 문서만 tombstone", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });

		for (const p of ["keep1.md", "keep2.md", "gone.md"]) dev.vault.seed(p, `c-${p}`);
		await dev.sync("both"); // 기준선 기록 + 업로드

		const gone = dev.vault.getAbstractFileByPath("gone.md");
		await dev.vault.delete(gone as any); // 오프라인 삭제

		await dev.sync("both");

		expect((await dev.note("gone.md"))?.deleted).toBe(true);
		expect((await dev.note("keep1.md"))?.deleted).toBe(false);
		expect((await dev.note("keep2.md"))?.deleted).toBe(false);
	});

	it("시나리오2b: 기준선 이후 다른 기기가 바꾼 파일은 로컬에서 사라져도 tombstone하지 않음(보존)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("x.md", "v1");
		await a.sync("both"); // a의 기준선: x.md rev=R1, hash(v1)

		// 다른 기기 b가 x.md를 v2로 수정해 원격에 올린다.
		await b.pull();
		b.vault.seed("x.md", "v2");
		await b.uploader.uploadPath("x.md");
		await b.push();

		// a가 원격 변경을 받아오면 a 로컬 rev가 R1→R2로 달라진다.
		await a.pull();

		// 그 상태에서 a가 x.md를 로컬 삭제하고 전체 동기화.
		const x = a.vault.getAbstractFileByPath("x.md");
		await a.vault.delete(x as any);
		await a.sync("both");

		// rev가 기준선과 달라졌으므로 보존되어야 한다(tombstone 금지).
		expect((await a.note("x.md"))?.deleted).toBe(false);
	});

	it("시작 정합(runStartup)은 pull 후 정합 — 다른 기기 수정분을 stale tombstone하지 않음", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("x.md", "v1");
		await a.sync("both"); // a 기준선(R1)

		// 다른 기기 b가 원격에서 R2로 수정(a는 아직 pull 안 함)
		await b.pull();
		b.vault.seed("x.md", "v2");
		await b.uploader.uploadPath("x.md");
		await b.push();

		// a는 오프라인 동안 로컬에서만 삭제(아직 R2 미수신)
		await a.vault.delete(a.vault.getAbstractFileByPath("x.md") as any);

		// 자동 시작 경로: pull 먼저 → reconcile → stale tombstone 방지.
		await a.fullSync.runStartup();

		expect((await a.note("x.md"))?.deleted).toBe(false); // tombstone 안 됨
		expect((await listDeleteModify(a.ctx.pouch)).map((e) => e.dbPath)).toContain("x.md"); // 삭제/수정 충돌로 보존
	});
});
