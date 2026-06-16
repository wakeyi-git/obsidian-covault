// PDF 등 첨부 충돌 해소가 _충돌/ 디스크 사본에만 의존하던 버그의 회귀 테스트.
// 사용자가 _충돌/ 사본을 지웠거나 materialize가 안 됐을 때, '원격 적용'이 조용히 로컬을 유지하고
// '두 버전 보관'이 원격본을 잃었다. 이제 원격/로컬 바이너리를 PouchDB(복제된 원본)에서 복원한다.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { assetId } from "../../src/core/model/types";
import { insertLabelBeforeExt } from "../../src/core/path/path";
import { t } from "../../src/i18n";

function buf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer;
}
function bytes(b: ArrayBuffer | null): number[] {
	return b ? Array.from(new Uint8Array(b)) : [];
}

describe("PDF(첨부) 충돌 해소 — _충돌/ 사본이 없어도", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	const PDF = "docs/report.pdf";
	// 첨부 충돌본 사본 경로: 노트와 달리 insertLabelBeforeExt(점 구분) — report.충돌본.pdf
	const keepCopy = insertLabelBeforeExt(PDF, t("mode.conflicted"));

	/** 원격(a)이 winner인 첨부 충돌을 만든 뒤, 사용자가 _충돌/ 사본을 지운 상태로 둔다. */
	async function conflictWithoutCopy() {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seedBinary(PDF, buf("BASE"));
		await a.uploader.uploadPath(PDF);
		await a.push();
		await b.pull();

		b.vault.seedBinary(PDF, buf("B-edit"));
		await b.uploader.uploadPath(PDF);
		a.vault.seedBinary(PDF, buf("A1"));
		await a.uploader.uploadPath(PDF);
		a.vault.seedBinary(PDF, buf("A2-final")); // a gen3 → winner
		await a.uploader.uploadPath(PDF);
		await a.push();

		await b.pull();
		const doc = await b.ctx.pouch.getWithConflicts<{ _conflicts?: string[] }>(assetId(PDF));
		expect(doc?._conflicts?.length).toBeGreaterThan(0);
		await b.applier.applyAsset(doc as never);

		// 사용자가 _충돌/ 사본을 지운다(흔한 상황).
		const cp = b.ctx.conflictLocalPath(PDF);
		const f = b.ctx.getFile(cp);
		if (f) await b.ctx.deleteVaultFile(f);
		expect(await b.ctx.readVaultBinary(cp)).toBeNull();
		return b;
	}

	it("원격 적용: 라이브가 PouchDB의 원격본으로 갱신되고 충돌 collapse", async () => {
		const b = await conflictWithoutCopy();
		await b.conflicts.resolve(PDF, "remote");
		expect(bytes(await b.ctx.readVaultBinary(PDF))).toEqual(bytes(buf("A2-final")));
		expect((await b.ctx.pouch.getWithConflicts<{ _conflicts?: string[] }>(assetId(PDF)))?._conflicts ?? []).toHaveLength(0);
	});

	it("로컬 유지: 라이브는 로컬 유지하고 충돌 collapse", async () => {
		const b = await conflictWithoutCopy();
		await b.conflicts.resolve(PDF, "local");
		expect(bytes(await b.ctx.readVaultBinary(PDF))).toEqual(bytes(buf("B-edit")));
		expect((await b.ctx.pouch.getWithConflicts<{ _conflicts?: string[] }>(assetId(PDF)))?._conflicts ?? []).toHaveLength(0);
	});

	it("두 버전 보관(로컬 최종): 원격본을 PouchDB에서 복원해 사본으로 보관", async () => {
		const b = await conflictWithoutCopy();
		await b.conflicts.resolve(PDF, "both");
		expect(bytes(await b.ctx.readVaultBinary(PDF))).toEqual(bytes(buf("B-edit"))); // 로컬 최종
		expect(bytes(await b.ctx.readVaultBinary(keepCopy))).toEqual(bytes(buf("A2-final"))); // 원격본 보존
		expect((await b.ctx.pouch.getWithConflicts<{ _conflicts?: string[] }>(assetId(PDF)))?._conflicts ?? []).toHaveLength(0);
	});
});
