// Phase 1: 삭제 파일 복구. tombstone → listDeleted → restore 흐름을 실제 엔진으로 검증.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { RestoreManager } from "../../src/core/sync/RestoreManager";

describe("삭제 파일 복구 (RestoreManager)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("노트: tombstone을 content 보존으로 복구(deleted=false, vault 재생성)", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });
		const restorer = new RestoreManager(dev.ctx, dev.uploader);

		dev.vault.seed("notes/a.md", "hello world");
		await dev.uploader.uploadPath("notes/a.md");

		// 삭제(vault 제거 + tombstone)
		const f = dev.vault.getAbstractFileByPath("notes/a.md");
		await dev.vault.delete(f as any);
		await dev.uploader.tombstonePath("notes/a.md");
		expect((await dev.note("notes/a.md"))?.deleted).toBe(true);

		// 목록에 보이고 복구 가능
		const list = await restorer.listDeleted();
		const item = list.find((i) => i.dbPath === "notes/a.md");
		expect(item?.recoverable).toBe(true);
		expect(item?.kind).toBe("note");

		// 복구
		expect(await restorer.restore("notes/a.md")).toBe("restored");
		expect((await dev.note("notes/a.md"))?.deleted).toBe(false);
		expect((await dev.note("notes/a.md"))?.content).toBe("hello world");
		expect(dev.vault.textOf("notes/a.md")).toBe("hello world");
	});

	it("노트: 원래 위치에 파일이 있으면 keep-both로 '(복구본)' 생성", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });
		const restorer = new RestoreManager(dev.ctx, dev.uploader);

		dev.vault.seed("a.md", "v1");
		await dev.uploader.uploadPath("a.md");
		await dev.uploader.tombstonePath("a.md");
		// 같은 경로에 새 파일이 다시 생김
		dev.vault.seed("a.md", "new content");

		expect(await restorer.restore("a.md", { collision: "keep-both" })).toBe("restored");
		expect(dev.vault.textOf("a.md")).toBe("new content"); // 기존 유지
		expect(dev.vault.textOf("a.복구본.md")).toBe("v1"); // 복구본
		// P2-a: 다른 이름으로 복구했으면 원래 tombstone이 삭제 목록에서 사라진다.
		expect((await restorer.listDeleted()).some((i) => i.dbPath === "a.md")).toBe(false);
	});

	it("첨부: archive 사본이 없으면 복구 불가, 있으면 복구", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });
		const restorer = new RestoreManager(dev.ctx, dev.uploader);

		const data = new TextEncoder().encode("PNGDATA").buffer;
		dev.vault.seedBinary("img/p.png", data);
		await dev.uploader.uploadPath("img/p.png");
		const pf = dev.vault.getAbstractFileByPath("img/p.png");
		await dev.vault.delete(pf as any);
		await dev.uploader.tombstonePath("img/p.png");

		// archive 사본 없음 → 복구 불가
		let item = (await restorer.listDeleted()).find((i) => i.dbPath === "img/p.png");
		expect(item?.recoverable).toBe(false);
		expect(await restorer.restore("img/p.png")).toBe("unrecoverable");

		// archive 사본을 두면 복구 가능
		dev.vault.seedBinary(dev.ctx.archiveLocalPath("img/p.png"), data);
		item = (await restorer.listDeleted()).find((i) => i.dbPath === "img/p.png");
		expect(item?.recoverable).toBe(true);
		expect(await restorer.restore("img/p.png")).toBe("restored");
		expect((await dev.asset("img/p.png"))?.deleted).toBe(false);
		expect(dev.vault.has("img/p.png")).toBe(true);
	});

	it("첨부: 같은 이름 존재 시 (복구본)으로 복구하고 원래 tombstone 정리", async () => {
		cluster = new Cluster();
		const dev = cluster.device({ deviceId: "d", role: "manager", remoteDb: "mirror_s1" });
		const restorer = new RestoreManager(dev.ctx, dev.uploader);

		const data = new TextEncoder().encode("ORIG").buffer;
		dev.vault.seedBinary("img/p.png", data);
		await dev.uploader.uploadPath("img/p.png");
		await dev.vault.delete(dev.vault.getAbstractFileByPath("img/p.png") as any);
		await dev.uploader.tombstonePath("img/p.png");

		// archive 사본(복구 가능) + 원래 위치에 같은 이름의 새 파일(충돌)
		dev.vault.seedBinary(dev.ctx.archiveLocalPath("img/p.png"), data);
		dev.vault.seedBinary("img/p.png", new TextEncoder().encode("NEW").buffer);

		expect(await restorer.restore("img/p.png", { collision: "keep-both" })).toBe("restored");
		// (복구본)으로 복구되고 기존 파일은 유지
		expect(dev.vault.has("img/p.복구본.png")).toBe(true);
		expect(await dev.asset("img/p.복구본.png")).toBeTruthy();
		expect(bytes(await dev.ctx.readVaultBinary("img/p.복구본.png"))).toEqual(bytes(data));
		// P2-a: 원래 tombstone은 삭제 목록에서 사라진다.
		expect((await restorer.listDeleted()).some((i) => i.dbPath === "img/p.png")).toBe(false);
	});
});

function bytes(b: ArrayBuffer | null): number[] {
	return b ? Array.from(new Uint8Array(b)) : [];
}
