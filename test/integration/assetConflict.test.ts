// Phase 2: 첨부(asset) 충돌이 충돌 목록에 노출되고 해소되는지 — 실제 replication 충돌로 검증.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { assetId } from "../../src/core/model/types";

function buf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer;
}
function bytes(b: ArrayBuffer | null): number[] {
	return b ? Array.from(new Uint8Array(b)) : [];
}

describe("첨부 충돌 (asset conflict)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	async function makeConflict() {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seedBinary("img/p.png", buf("BASE"));
		await a.uploader.uploadPath("img/p.png");
		await a.push();
		await b.pull();

		// b: 1회 수정(gen2)
		b.vault.seedBinary("img/p.png", buf("B-edit"));
		await b.uploader.uploadPath("img/p.png");

		// a: 2회 수정(gen3)으로 승자를 a로 결정적으로
		a.vault.seedBinary("img/p.png", buf("A1"));
		await a.uploader.uploadPath("img/p.png");
		a.vault.seedBinary("img/p.png", buf("A2-final"));
		await a.uploader.uploadPath("img/p.png");
		await a.push();

		await b.pull();
		// 충돌 적용 → _충돌/에 원격본 materialize
		const doc = await b.ctx.pouch.getWithConflicts<any>(assetId("img/p.png"));
		expect(doc?._conflicts?.length).toBeGreaterThan(0);
		await b.applier.applyAsset(doc);
		return { a, b };
	}

	it("첨부 충돌이 충돌 목록에 kind=asset으로 표시된다", async () => {
		const { b } = await makeConflict();
		const list = await b.conflicts.list();
		const item = list.find((i) => i.dbPath === "img/p.png");
		expect(item?.kind).toBe("asset");
		expect(item?.mime).toBe("image/png");
		expect(item?.size).toBeGreaterThan(0);
	});

	it("원격 적용: 라이브 바이너리가 원격본으로 갱신되고 충돌 collapse", async () => {
		const { b } = await makeConflict();
		await b.conflicts.resolve("img/p.png", "remote");
		// 라이브 = 원격본(A2-final)
		expect(bytes(await b.ctx.readVaultBinary("img/p.png"))).toEqual(bytes(buf("A2-final")));
		// _conflicts collapse
		const after = await b.ctx.pouch.getWithConflicts<any>(assetId("img/p.png"));
		expect(after?._conflicts ?? []).toHaveLength(0);
	});

	it("로컬 유지: 라이브는 로컬 유지하고 충돌 collapse", async () => {
		const { b } = await makeConflict();
		await b.conflicts.resolve("img/p.png", "local");
		expect(bytes(await b.ctx.readVaultBinary("img/p.png"))).toEqual(bytes(buf("B-edit")));
		const after = await b.ctx.pouch.getWithConflicts<any>(assetId("img/p.png"));
		expect(after?._conflicts ?? []).toHaveLength(0);
	});

	// 로컬 branch가 winner가 되는 경우: _충돌/에 보존되는 '원격본'이 실제 원격 바이너리여야 한다(보고서 P1).
	async function makeLocalWinsConflict() {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seedBinary("img/p.png", buf("BASE"));
		await a.uploader.uploadPath("img/p.png");
		await a.push();
		await b.pull();

		// a: 1회 수정(gen2, 원격본)
		a.vault.seedBinary("img/p.png", buf("A-remote"));
		await a.uploader.uploadPath("img/p.png");
		await a.push();

		// b: 2회 수정(gen3)으로 b(로컬)가 winner가 되도록
		b.vault.seedBinary("img/p.png", buf("B1"));
		await b.uploader.uploadPath("img/p.png");
		b.vault.seedBinary("img/p.png", buf("B-local-final"));
		await b.uploader.uploadPath("img/p.png");

		await b.pull(); // a gen2 vs b gen3 → b(로컬)가 winner
		const doc = await b.ctx.pouch.getWithConflicts<any>(assetId("img/p.png"));
		expect(doc?._conflicts?.length).toBeGreaterThan(0);
		await b.applier.applyAsset(doc);
		return { b };
	}

	it("로컬이 winner여도 _충돌/에 보존되는 건 실제 원격(A) 바이너리", async () => {
		const { b } = await makeLocalWinsConflict();
		const conflictPath = b.ctx.conflictLocalPath("img/p.png");
		// 수정 전이라면 winner(=로컬 B-local-final)가 저장돼 버그. 수정 후엔 원격 A-remote.
		expect(bytes(await b.ctx.readVaultBinary(conflictPath))).toEqual(bytes(buf("A-remote")));
	});

	it("로컬 winner 상태에서 '원격 적용' → live가 실제 원격 바이너리로 바뀜", async () => {
		const { b } = await makeLocalWinsConflict();
		await b.conflicts.resolve("img/p.png", "remote");
		expect(bytes(await b.ctx.readVaultBinary("img/p.png"))).toEqual(bytes(buf("A-remote")));
	});
});

describe("첨부 수신(pull) 크기 게이트 (P1-1 #4)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("기기 한도를 넘는 원격 첨부는 다운로드·vault 쓰기를 건너뛴다(다른 기기가 올린 대용량으로부터 보호)", async () => {
		cluster = new Cluster();
		// a: 무제한 업로드. b: maxAttachmentMB=1(모바일 가정).
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1", settings: { maxAttachmentMB: 0 } });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1", settings: { maxAttachmentMB: 1 } });

		const big = new ArrayBuffer(2 * 1024 * 1024); // 2MB > 1MB 한도
		a.vault.seedBinary("img/big.png", big);
		await a.uploader.uploadPath("img/big.png");
		await a.push();
		await b.pull();

		const doc = await b.ctx.pouch.getWithConflicts<any>(assetId("img/big.png"));
		expect(doc?.size).toBe(2 * 1024 * 1024); // 메타에 크기 존재(다운로드 전 판정 근거)
		const res = await b.applier.applyAsset(doc);
		expect(res).toBe("skipped-too-large");
		expect(await b.ctx.readVaultBinary("img/big.png")).toBeNull(); // vault에 쓰지 않음
	});

	it("한도 이하 첨부는 정상 수신된다(게이트가 작은 파일을 막지 않음)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1", settings: { maxAttachmentMB: 0 } });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1", settings: { maxAttachmentMB: 1 } });

		a.vault.seedBinary("img/small.png", buf("작은 파일"));
		await a.uploader.uploadPath("img/small.png");
		await a.push();
		await b.pull();

		const doc = await b.ctx.pouch.getWithConflicts<any>(assetId("img/small.png"));
		const res = await b.applier.applyAsset(doc);
		expect(res).toBe("applied");
		expect(bytes(await b.ctx.readVaultBinary("img/small.png"))).toEqual(bytes(buf("작은 파일")));
	});
});
