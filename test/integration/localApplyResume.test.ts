// LocalApplier(실엔진) 종단 검증: 원격 변경 적용 + 체크포인트(lastSeq) 증분 재개.
// 하니스에 LocalApplier 경로를 배선해, main.ts 동기화 로직 분해 시 회귀를 잡는 안전망.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster, settle } from "../harness/env";

describe("LocalApplier 종단(적용 + 증분 재개)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("원격 변경을 vault에 적용하고 체크포인트를 전진시킨다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("x.md", "v1");
		await a.uploader.uploadPath("x.md");
		await a.push();
		await b.pull(); // b 로컬 DB에는 들어왔지만 vault엔 아직 미적용

		const la = b.makeLocalApplier();
		la.start();
		await settle();
		la.stop();

		expect(b.vault.textOf("x.md")).toBe("v1"); // LocalApplier가 vault에 적용
		expect(Number(b.ctx.getLastSeq())).toBeGreaterThan(0); // 체크포인트 전진
	});

	it("재시작 시 체크포인트 이후 변경만 처리한다(증분 재개)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s2" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s2" });

		a.vault.seed("x.md", "v1");
		await a.uploader.uploadPath("x.md");
		await a.push();
		await b.pull();

		const la1 = b.makeLocalApplier();
		la1.start();
		await settle();
		la1.stop();
		const seqAfterV1 = Number(b.ctx.getLastSeq());
		expect(b.vault.textOf("x.md")).toBe("v1");

		// 두 번째 변경
		a.vault.seed("x.md", "v2");
		await a.uploader.uploadPath("x.md");
		await a.push();
		await b.pull();

		const la2 = b.makeLocalApplier(); // since=저장된 lastSeq에서 재개
		la2.start();
		await settle();
		la2.stop();

		expect(b.vault.textOf("x.md")).toBe("v2"); // 새 변경 적용
		expect(Number(b.ctx.getLastSeq())).toBeGreaterThan(seqAfterV1); // 추가 전진
	});

	it("적용 실패가 나면 체크포인트가 실패 지점 이전에서 멈춘다(재처리 보장)", async () => {
		cluster = new Cluster();
		const d = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s3" });
		d.vault.seed("good.md", "1");
		await d.uploader.uploadPath("good.md");
		d.vault.seed("bad.md", "2");
		await d.uploader.uploadPath("bad.md");

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
		const la = d.makeLocalApplier({ applier: stub as any });
		la.start();
		await seenBad;
		await settle();
		la.stop();

		const last = Number(d.ctx.getLastSeq());
		const head = Number(await d.ctx.pouch.currentLocalSeq());
		expect(last).toBeGreaterThan(0); // good.md는 체크포인트됨
		expect(last).toBeLessThan(head); // bad.md(이후)는 미체크포인트 → 재시작 시 재처리
	});
});
