// 평가(2026-06-12) 즉시 조치 회귀 테스트 — D-1(업로드 재시도 보존)·D-3-③(sweep rev 검증).
// 레이스는 putWithRev/putAssetWithRev 첫 호출 직전에 "끼어드는 변경"을 주입해 결정적으로 재현한다
// (revGuardedPut.test.ts와 동일 기법).
import { describe, it, expect, afterEach } from "vitest";
import { Cluster, Device } from "../harness/env";
import { noteId, assetId, NoteDoc, AssetDoc } from "../../src/core/model/types";
import { sha256 } from "../../src/core/hash/hash";
import { sweepTombstones } from "../../src/core/sync/tombstoneRetention";
import { DAY_MS } from "../../src/core/sync/versionRetention";

function buf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer;
}
function bytes(b: ArrayBuffer | null): number[] {
	return b ? Array.from(new Uint8Array(b)) : [];
}

/** putWithRev 첫 호출 직전에 inject를 실행하는 스파이 설치(이후 호출은 원본 그대로). */
function injectBeforeFirstPut(dev: Device, targetId: string, inject: () => Promise<void>): void {
	const pouch = dev.ctx.pouch;
	const orig = pouch.putWithRev.bind(pouch);
	let armed = true;
	pouch.putWithRev = (async (doc: { _id: string }, rev: string | undefined) => {
		if (armed && doc._id === targetId) {
			armed = false;
			await inject();
		}
		return orig(doc as never, rev);
	}) as typeof pouch.putWithRev;
}

/** putAssetWithRev 변형(첨부 업로드 경로). */
function injectBeforeFirstAssetPut(dev: Device, targetPath: string, inject: () => Promise<void>): void {
	const pouch = dev.ctx.pouch;
	const orig = pouch.putAssetWithRev.bind(pouch);
	let armed = true;
	pouch.putAssetWithRev = (async (doc: AssetDoc, data: ArrayBuffer, rev: string | undefined) => {
		if (armed && doc.path === targetPath) {
			armed = false;
			await inject();
		}
		return orig(doc, data, rev);
	}) as typeof pouch.putAssetWithRev;
}

describe("업로드 재시도에 끼어든 원격 내용 보존 (D-1)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("uploadPath(노트): 끼어든 다른 기기의 새 내용을 버전(kind=conflict)으로 보존한 뒤 덮는다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_d1" });

		a.vault.seed("doc.md", "v1");
		await a.uploader.uploadPath("doc.md");

		// 로컬 편집 + 업로드가 진행되는 사이, 다른 기기의 새 내용이 pull로 도착하는 상황을 주입.
		a.vault.seed("doc.md", "v2-local");
		injectBeforeFirstPut(a, noteId("doc.md"), async () => {
			const cur = await a.ctx.pouch.get<NoteDoc>(noteId("doc.md"));
			await a.ctx.pouch.put({
				...cur!,
				content: "intervening remote",
				contentHash: await sha256("intervening remote"),
				version: (cur!.version ?? 0) + 1,
				lastModifiedDeviceId: "other-device",
			});
		});

		const res = await a.uploader.uploadPath("doc.md");
		expect(res).toBe("uploaded");
		// 최종본은 로컬 편집이지만, 끼어든 원격 내용은 흔적 없이 사라지지 않고 버전에 남는다.
		const doc = await a.ctx.pouch.get<NoteDoc>(noteId("doc.md"));
		expect(doc?.content).toBe("v2-local");
		const versions = await a.ctx.versions.list("doc.md");
		expect(versions.some((v) => v.content === "intervening remote" && v.kind === "conflict")).toBe(true);
	});

	it("uploadContent(실시간 스냅샷): 끼어든 새 내용을 버전으로 보존한다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_d2" });

		a.vault.seed("doc.md", "v1");
		await a.uploader.uploadPath("doc.md");

		injectBeforeFirstPut(a, noteId("doc.md"), async () => {
			const cur = await a.ctx.pouch.get<NoteDoc>(noteId("doc.md"));
			await a.ctx.pouch.put({
				...cur!,
				content: "member offline edit",
				contentHash: await sha256("member offline edit"),
				version: (cur!.version ?? 0) + 1,
				lastModifiedDeviceId: "other-device",
			});
		});

		const res = await a.uploader.uploadContent("doc.md", "session content");
		expect(res).toBe("uploaded");
		const versions = await a.ctx.versions.list("doc.md");
		expect(versions.some((v) => v.content === "member offline edit" && v.kind === "conflict")).toBe(true);
	});

	it("uploadPath(첨부): 끼어든 원격 바이너리를 _충돌/ 사본으로 보존한다(첨부는 버전 히스토리 없음)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_d3" });

		a.vault.seedBinary("img/p.png", buf("BASE"));
		await a.uploader.uploadPath("img/p.png");

		a.vault.seedBinary("img/p.png", buf("LOCAL2"));
		injectBeforeFirstAssetPut(a, "img/p.png", async () => {
			const cur = await a.ctx.pouch.get<AssetDoc>(assetId("img/p.png"));
			await a.ctx.pouch.putAsset(
				{
					...cur!,
					contentHash: await sha256(buf("INTERVENE")),
					version: (cur!.version ?? 0) + 1,
					lastModifiedDeviceId: "other-device",
				},
				buf("INTERVENE"),
			);
		});

		const res = await a.uploader.uploadPath("img/p.png");
		expect(res).toBe("uploaded");
		// 라이브는 로컬 편집, 끼어든 원격 바이너리는 _충돌/ 사본으로 보존.
		expect(bytes(await a.ctx.readVaultBinary("img/p.png"))).toEqual(bytes(buf("LOCAL2")));
		const copy = await a.ctx.readVaultBinary(a.ctx.conflictLocalPath("img/p.png"));
		expect(bytes(copy)).toEqual(bytes(buf("INTERVENE")));
	});
});

describe("tombstone 스윕의 rev 검증 (D-3-③)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("스윕 중 부활한 노트를 stale tombstone으로 덮지 않는다(conflict → skip)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_d4" });

		// 보존 기간이 지난 tombstone 구성.
		a.vault.seed("gone.md", "old content");
		await a.uploader.uploadPath("gone.md");
		await a.uploader.tombstonePath("gone.md");
		const tomb = await a.ctx.pouch.get<NoteDoc>(noteId("gone.md"));
		await a.ctx.pouch.put({ ...tomb!, deletedAt: new Date(Date.now() - 40 * DAY_MS).toISOString() });

		// allNotes→putWithRev 사이에 원격 부활이 끼어드는 상황을 주입.
		injectBeforeFirstPut(a, noteId("gone.md"), async () => {
			const cur = await a.ctx.pouch.get<NoteDoc>(noteId("gone.md"));
			await a.ctx.pouch.put({
				...cur!,
				deleted: false,
				content: "revived",
				contentHash: await sha256("revived"),
				version: (cur!.version ?? 0) + 1,
				lastModifiedDeviceId: "other-device",
			});
		});

		const stripped = await sweepTombstones(a.ctx, 30);
		expect(stripped).toBe(0); // conflict → skip, 카운트 없음
		// 이전(LWW put)이라면 부활 노트 위에 content:"" tombstone이 덮였다.
		const doc = await a.ctx.pouch.get<NoteDoc>(noteId("gone.md"));
		expect(doc?.deleted).toBe(false);
		expect(doc?.content).toBe("revived");
	});
});
