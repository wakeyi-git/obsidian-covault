// Phase 4: 사용자용 버전 히스토리 — 편집/삭제 스냅샷, 복원, 보존 한도.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";

describe("버전 히스토리", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("편집마다 스냅샷이 쌓이고 과거 버전으로 복원된다", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });

		for (const v of ["v1", "v2", "v3"]) {
			dev.vault.seed("a.md", v);
			await dev.uploader.uploadPath("a.md");
		}

		const versions = await dev.ctx.versions.list("a.md");
		expect(versions.map((x) => x.content)).toEqual(["v3", "v2", "v1"]); // 최신순
		expect(versions.every((x) => x.kind === "modify")).toBe(true);

		// 가장 오래된 v1로 복원(현재 백업 포함)
		const v1 = versions[versions.length - 1];
		expect(await dev.ctx.versions.restoreVersion(v1._id, { backupCurrent: true })).toBe("restored");
		expect(dev.vault.textOf("a.md")).toBe("v1");
		expect((await dev.note("a.md"))?.content).toBe("v1");

		// 백업 스냅샷(restore kind)이 현재(v3) 내용으로 남았다.
		const after = await dev.ctx.versions.list("a.md");
		expect(after.some((x) => x.kind === "restore" && x.content === "v3")).toBe(true);
	});

	it("삭제 직전 내용이 스냅샷으로 보존된다", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });
		dev.vault.seed("b.md", "keep-me");
		await dev.uploader.uploadPath("b.md");
		await dev.uploader.tombstonePath("b.md");

		const versions = await dev.ctx.versions.list("b.md");
		expect(versions.some((x) => x.kind === "delete" && x.content === "keep-me")).toBe(true);
	});

	it("보존 한도(개수)를 넘으면 오래된 버전 정리", async () => {
		cluster = new Cluster();
		const dev = cluster.device({
			deviceId: "d",
			role: "manager",
			remoteDb: "mirror_s1",
			settings: { versionMaxCount: 2, versionMaxAgeDays: 0 },
		});
		for (const v of ["1", "2", "3", "4"]) {
			dev.vault.seed("c.md", v);
			await dev.uploader.uploadPath("c.md");
		}
		const versions = await dev.ctx.versions.list("c.md");
		expect(versions).toHaveLength(2);
		expect(versions.map((x) => x.content)).toEqual(["4", "3"]); // 최신 2개만
	});

	it("P2-b: 실시간 스냅샷(uploadContent)도 버전을 남기고 동일 내용은 dedupe", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });

		await dev.uploader.uploadContent("rt.md", "v1");
		expect(await dev.ctx.versions.list("rt.md")).toHaveLength(1);
		await dev.uploader.uploadContent("rt.md", "v1"); // 동일 내용 → dedupe(스킵)
		expect(await dev.ctx.versions.list("rt.md")).toHaveLength(1);
		await dev.uploader.uploadContent("rt.md", "v2");
		const v = await dev.ctx.versions.list("rt.md");
		expect(v.map((x) => x.content)).toEqual(["v2", "v1"]);
	});

	it("versionHistory=false면 스냅샷을 남기지 않는다", async () => {
		cluster = new Cluster();
		const dev = cluster.device({
			deviceId: "d",
			role: "manager",
			remoteDb: "mirror_s1",
			settings: { versionHistory: false },
		});
		dev.vault.seed("d.md", "x");
		await dev.uploader.uploadPath("d.md");
		expect(await dev.ctx.versions.list("d.md")).toHaveLength(0);
	});
});
