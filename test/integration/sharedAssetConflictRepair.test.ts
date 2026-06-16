// Plan B 회귀: 공유 공간의 충돌난 PDF(asset)가 삭제해도 부활하고 충돌 목록에 계속 뜨는 문제.
// 수정1: tombstonePath가 충돌 리프까지 제거(부활 차단). 수정2: tombstoneRemoteDoc가 원격 리프까지 제거.
// 수정3: 읽기전용 구성원은 해소 불가능한 asset 충돌을 winner(정본)로 적용하고 목록·배지에서 숨김.
// 수정4: 해소가 notifyLocalWrite로 push를 깨운다.
import { describe, it, expect, afterEach, vi } from "vitest";
import { Cluster } from "../harness/env";
import { MirrorSync } from "../../src/core/sync/MirrorSync";
import { assetId, noteId } from "../../src/core/model/types";

function buf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer;
}
function bytes(b: ArrayBuffer | null): number[] {
	return b ? Array.from(new Uint8Array(b)) : [];
}

describe("공유 asset 충돌 — 삭제 부활 차단 + 읽기전용 숨김 (Plan B)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	/** a(승자 브랜치)·b(패자 브랜치)가 같은 공유 DB에 충돌을 만든다. 반환 b는 _conflicts 보유. */
	async function makeRemoteConflict(roB: { sharedReadOnly?: boolean } = {}) {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "share_x" });
		const b = cluster.device({
			deviceId: "b",
			role: roB.sharedReadOnly ? "member" : "manager",
			remoteDb: "share_x",
			...(roB.sharedReadOnly ? { settings: { remoteDb: "mirror_self", sharedReadOnly: true } } : {}),
		});

		a.vault.seedBinary("자료/p.pdf", buf("BASE"));
		await a.uploader.uploadPath("자료/p.pdf");
		await a.push();
		await b.pull();

		if (!roB.sharedReadOnly) {
			// b가 패자 브랜치 push(읽기전용이 아닐 때만 — 원격에 충돌 리프 적재)
			b.vault.seedBinary("자료/p.pdf", buf("B-edit"));
			await b.uploader.uploadPath("자료/p.pdf");
			await b.push();
		} else {
			// 읽기전용 시나리오: 다른 관리자 c가 패자 브랜치를 원격에 올려 충돌을 만든다.
			const c = cluster.device({ deviceId: "c", role: "manager", remoteDb: "share_x" });
			await c.pull();
			c.vault.seedBinary("자료/p.pdf", buf("C-edit"));
			await c.uploader.uploadPath("자료/p.pdf");
			await c.push();
		}

		// a가 승자 브랜치(2회 수정)로 결정적 승자 + push
		a.vault.seedBinary("자료/p.pdf", buf("A1"));
		await a.uploader.uploadPath("자료/p.pdf");
		a.vault.seedBinary("자료/p.pdf", buf("A2-final"));
		await a.uploader.uploadPath("자료/p.pdf");
		await a.push();

		await b.pull();
		return { a, b };
	}

	it("수정1: 충돌난 asset을 삭제하면 모든 리프가 사라지고 부활하지 않는다", async () => {
		const { a, b } = await makeRemoteConflict();
		const before = await b.ctx.pouch.getWithConflicts<any>(assetId("자료/p.pdf"));
		expect(before?._conflicts?.length).toBeGreaterThan(0); // 충돌 존재 확인

		// b가 삭제(tombstone) — winner + 충돌 리프 모두 제거되어야 한다.
		expect(await b.uploader.tombstonePath("자료/p.pdf")).toBe("tombstoned");
		const after = await b.ctx.pouch.getWithConflicts<any>(assetId("자료/p.pdf"));
		expect(after?.deleted).toBe(true);
		expect(after?._conflicts ?? []).toHaveLength(0); // 충돌 리프 잔존 없음(부활 차단의 핵심)

		// 원격에 전파 후 a가 받아도 부활하지 않는다(살아있는 리프 없음).
		await b.push();
		await a.pull();
		const onA = await a.ctx.pouch.getWithConflicts<any>(assetId("자료/p.pdf"));
		expect(onA?.deleted).toBe(true);
		expect(onA?._conflicts ?? []).toHaveLength(0);
	});

	it("수정2: 관리자 정합복구(tombstoneRemoteDoc)가 원격 충돌 리프까지 제거한다", async () => {
		const { a, b } = await makeRemoteConflict();
		await b.push(); // 원격에 양 브랜치 적재(충돌)

		// 원격을 직접 tombstone — winner + 원격 충돌 리프 모두 제거.
		expect(await a.ctx.pouch.tombstoneRemoteDoc(assetId("자료/p.pdf"), { deleted: true })).toBe(true);

		// 새 관찰자가 원격을 통째로 받아도 살아있는 리프가 없다.
		const obs = cluster.device({ deviceId: "obs", role: "manager", remoteDb: "share_x" });
		await obs.pull();
		const doc = await obs.ctx.pouch.getWithConflicts<any>(assetId("자료/p.pdf"));
		expect(doc?.deleted).toBe(true);
		expect(doc?._conflicts ?? []).toHaveLength(0);
		expect(obs.ctx.getFile("자료/p.pdf")).toBeNull(); // vault 부활 없음
	});

	it("수정3: 읽기전용 구성원은 asset 충돌을 winner로 적용하고 목록에 띄우지 않는다", async () => {
		const { b } = await makeRemoteConflict({ sharedReadOnly: true });
		expect(b.ctx.isReadOnlyShared).toBe(true);
		const doc = await b.ctx.pouch.getWithConflicts<any>(assetId("자료/p.pdf"));
		expect(doc?._conflicts?.length).toBeGreaterThan(0); // 원격엔 충돌 존재

		// applyAsset이 "conflict"가 아니라 정상 적용(winner 채택)으로 처리.
		const res = await b.applier.applyAsset(doc);
		expect(res).not.toBe("conflict");
		// 충돌 목록·_충돌 사본에 노출되지 않는다.
		const list = await b.conflicts.list();
		expect(list.filter((c) => c.kind === "asset")).toHaveLength(0);
		expect(b.ctx.getFile(b.ctx.conflictLocalPath("자료/p.pdf"))).toBeNull();
		// vault는 winner 바이너리(정본).
		expect(bytes(await b.ctx.readVaultBinary("자료/p.pdf"))).toEqual(bytes(buf("A2-final")));
	});

	it("수정3c: 읽기전용 구성원의 충돌 카운트 배지가 asset을 세지 않는다", () => {
		cluster = new Cluster();
		const mem = cluster.device({
			deviceId: "mem",
			role: "member",
			remoteDb: "share_x",
			settings: { remoteDb: "mirror_self", sharedReadOnly: true },
		});
		const sync = new MirrorSync(mem.core, { memberId: "m", localRoot: "", remoteDb: "share_x", transport: () => "event" });
		expect(sync.ctx.isReadOnlyShared).toBe(true);
		sync.ctx.conflictIds.add(assetId("자료/p.pdf")); // 해소 불가능한 asset 충돌
		sync.ctx.conflictIds.add(noteId("메모.md")); // 노트 충돌은 여전히 센다
		expect(sync.conflictCount()).toBe(1);
	});

	it("충돌 해소 후 asset의 _충돌/ 원격본이 정리된다(사본 누적 방지)", async () => {
		cluster = new Cluster();
		const m = cluster.device({ deviceId: "m", role: "manager", remoteDb: "share_x" });
		m.vault.seedBinary("자료/p.pdf", buf("X"));
		await m.uploader.uploadPath("자료/p.pdf");

		// 충돌 시 남았던 _충돌/ 원격본을 모사.
		const copyPath = m.ctx.conflictLocalPath("자료/p.pdf");
		await m.ctx.writeVaultBinary(copyPath, buf("old-remote"));
		expect(m.ctx.getFile(copyPath)).not.toBeNull();

		// 충돌이 해소되어 양쪽이 같아진(_conflicts 없음) doc를 적용 → 남은 사본을 정리해야 한다.
		const doc = await m.ctx.pouch.getWithConflicts<any>(assetId("자료/p.pdf"));
		expect(await m.applier.applyAsset(doc)).toBe("skipped-same");
		expect(m.ctx.getFile(copyPath)).toBeNull(); // 누적되던 _충돌/ 사본이 정리됨
	});

	it("수정4: asset 충돌 해소가 notifyLocalWrite로 push를 깨운다", async () => {
		const { b } = await makeRemoteConflict();
		const doc = await b.ctx.pouch.getWithConflicts<any>(assetId("자료/p.pdf"));
		await b.applier.applyAsset(doc); // _충돌/ materialize
		const spy = vi.fn();
		b.ctx.notifyLocalWrite = spy;
		await b.conflicts.resolve("자료/p.pdf", "local");
		expect(spy).toHaveBeenCalled();
	});
});
