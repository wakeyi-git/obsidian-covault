// 동기화 일관성 부채 일괄(평가 P2-4) — preserveIntervening 첫 시도 적용 · restoreVersion rev 안전 ·
// purge 충돌 리프 제거. 좁은 레이스지만 데이터 무결성에 직결되는 경로를 실제 replication으로 검증한다.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { noteId } from "../../src/core/model/types";
import { sha256 } from "../../src/core/hash/hash";

function buf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer;
}
function txt(b: ArrayBuffer | null): string {
	return b ? new TextDecoder().decode(b) : "";
}

describe("preserveIntervening 첫 시도 적용 (P2-4)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("get 시점에 이미 보이는 다른 기기의 원격 내용을 덮기 전에 버전 히스토리로 보존한다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		// a가 원격에 내용을 올리고, b가 그대로 받아 b의 로컬 pouch에 'a-원격본'이 존재(같은 rev).
		a.vault.seed("doc.md", "from-a");
		await a.uploader.uploadPath("doc.md");
		await a.push();
		await b.pull();

		// b가 같은 파일을 로컬에서 다르게 편집해 업로드 — 첫 시도 put이 rev-일치로 성공하지만,
		// 덮이는 'from-a'(다른 기기)는 버전 히스토리에 conflict로 보존돼야 한다(과거엔 attempt>0에서만 보존).
		b.vault.seed("doc.md", "from-b");
		expect(await b.uploader.uploadPath("doc.md")).toBe("uploaded");
		expect((await b.note("doc.md"))?.content).toBe("from-b");

		const versions = await b.ctx.versions.list("doc.md");
		expect(versions.some((v) => v.kind === "conflict" && v.content === "from-a")).toBe(true);
	});

	it("내 기기가 만든 직전 내용은 보존 대상이 아니다(no-op — 불필요한 스냅샷 없음)", async () => {
		cluster = new Cluster();
		const d = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });
		d.vault.seed("x.md", "v1");
		await d.uploader.uploadPath("x.md");
		d.vault.seed("x.md", "v2");
		await d.uploader.uploadPath("x.md");
		const versions = await d.ctx.versions.list("x.md");
		expect(versions.every((v) => v.kind !== "conflict")).toBe(true); // 내 기기 연속 편집 → conflict 스냅샷 없음
	});
});

describe("restoreVersion rev 안전 (P2-4)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("복원은 최신 note 위에 쌓인다(version 단조 증가, 내용 정확)", async () => {
		cluster = new Cluster();
		const d = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });
		for (const v of ["v1", "v2", "v3"]) {
			d.vault.seed("a.md", v);
			await d.uploader.uploadPath("a.md");
		}
		const cur = await d.note("a.md");
		expect(cur?.version).toBe(3);

		const versions = await d.ctx.versions.list("a.md");
		const v1 = versions.find((x) => x.content === "v1")!;
		expect(await d.ctx.versions.restoreVersion(v1._id)).toBe("restored");

		const restored = await d.note("a.md");
		expect(restored?.content).toBe("v1");
		expect(restored?.version).toBe(4); // 최신(v3=version3) 위에 쌓임 — 옛 version으로 회귀하지 않음
		expect(d.vault.textOf("a.md")).toBe("v1");
	});
});

describe("purge 충돌 리프 제거 (P2-4)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("_conflicts가 있는 문서를 purge하면 승자·충돌 리프를 모두 제거해 부활하지 않는다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		// 분기 편집으로 _conflicts 생성(b gen2 vs a gen3, 승자 a).
		a.vault.seed("c.md", "base");
		await a.uploader.uploadPath("c.md");
		await a.push();
		await b.pull();
		b.vault.seed("c.md", "B-edit");
		await b.uploader.uploadPath("c.md");
		a.vault.seed("c.md", "A-edit1");
		await a.uploader.uploadPath("c.md");
		a.vault.seed("c.md", "A-edit2");
		await a.uploader.uploadPath("c.md");
		await a.push();
		await b.pull();

		const before = await b.ctx.pouch.getWithConflicts<any>(noteId("c.md"));
		expect(before?._conflicts?.length).toBeGreaterThan(0); // 충돌 리프 존재

		// purge → 승자 + 모든 충돌 리프 제거. winner만 지웠다면 리프가 승격돼 문서가 부활했을 것.
		expect(await b.uploader.purgePath("c.md")).toBe("purged");
		expect(await b.ctx.pouch.getWithConflicts<any>(noteId("c.md"))).toBeNull();
	});
});

describe("첨부 CAS — writeVaultBinaryIf (P2-4, 노트 D-2와 대칭)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("기대 해시가 현재 디스크와 일치할 때만 덮고, 끼어든 편집은 보존한다", async () => {
		cluster = new Cluster();
		const d = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });
		d.vault.seedBinary("img/p.png", buf("v1"));
		const v1Hash = await sha256(buf("v1"));

		// 기대 해시 일치 → 덮어쓴다
		expect(await d.ctx.writeVaultBinaryIf("img/p.png", v1Hash, buf("v2"))).toBe(true);
		expect(txt(await d.ctx.readVaultBinary("img/p.png"))).toBe("v2");

		// 끼어든 편집(현재 v2)인데 기대는 v1 → 덮지 않는다(보존)
		expect(await d.ctx.writeVaultBinaryIf("img/p.png", v1Hash, buf("remote"))).toBe(false);
		expect(txt(await d.ctx.readVaultBinary("img/p.png"))).toBe("v2");

		// 파일 없음 + 기대=없음(null) → 생성
		expect(await d.ctx.writeVaultBinaryIf("img/new.png", null, buf("created"))).toBe(true);
		expect(txt(await d.ctx.readVaultBinary("img/new.png"))).toBe("created");

		// 파일 없음 + 기대=있음 → 생성하지 않는다(읽기 이후 삭제 의심)
		expect(await d.ctx.writeVaultBinaryIf("img/absent.png", v1Hash, buf("x"))).toBe(false);
		expect(await d.ctx.readVaultBinary("img/absent.png")).toBeNull();
	});
});
