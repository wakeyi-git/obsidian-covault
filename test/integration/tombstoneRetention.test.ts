// tombstone 내용 보존 기간 정리(평가 I-3) — 스트립 후에도 동기화 정합성(부활 판정·에코)이 불변인지 검증.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { selectTombstonesToStrip, sweepTombstones } from "../../src/core/sync/tombstoneRetention";
import { RestoreManager } from "../../src/core/sync/RestoreManager";
import { noteId, NoteDoc } from "../../src/core/model/types";

const DAY = 24 * 60 * 60 * 1000;

describe("selectTombstonesToStrip (순수)", () => {
	const now = Date.parse("2026-06-11T00:00:00Z");
	const old = new Date(now - 40 * DAY).toISOString();
	const recent = new Date(now - 5 * DAY).toISOString();

	it("보존 기간 경과 + content 보유 tombstone만 고른다", () => {
		const out = selectTombstonesToStrip(
			[
				{ path: "old.md", deleted: true, content: "x", deletedAt: old },
				{ path: "recent.md", deleted: true, content: "x", deletedAt: recent },
				{ path: "live.md", deleted: false, content: "x", deletedAt: old },
				{ path: "already.md", deleted: true, content: "", deletedAt: old, contentStripped: true },
				{ path: "no-date.md", deleted: true, content: "x" }, // 시각 미상 → 보존(안전)
			],
			now,
			30,
		);
		expect(out).toEqual(["old.md"]);
	});

	it("maxAgeDays가 0/음수면 아무것도 고르지 않는다", () => {
		expect(selectTombstonesToStrip([{ path: "a.md", deleted: true, content: "x", deletedAt: old }], now, 0)).toEqual([]);
	});
});

describe("sweepTombstones (실엔진)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("스트립 후: 복구는 만료되지만 부활 판정(해시)·에코 차단은 불변", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_t1" });

		// 노트 업로드 후 삭제 → tombstone(content 보존)
		a.vault.seed("doc.md", "original content");
		await a.uploader.uploadPath("doc.md");
		const f = a.ctx.getFile("doc.md");
		await a.vault.trash(f!, false);
		await a.uploader.tombstonePath("doc.md");

		// 보존 기간 경과를 흉내: deletedAt을 40일 전으로 되돌린다
		const tomb = await a.ctx.pouch.get<NoteDoc>(noteId("doc.md"));
		await a.ctx.pouch.put({ ...tomb!, deletedAt: new Date(Date.now() - 40 * DAY).toISOString() });

		const stripped = await sweepTombstones(a.ctx, 30);
		expect(stripped).toBe(1);

		const after = await a.ctx.pouch.get<NoteDoc>(noteId("doc.md"));
		expect(after?.content).toBe("");
		expect(after?.contentStripped).toBe(true);
		expect(after?.contentHash).toBe(tomb?.contentHash); // 부활 판정용 해시 유지
		expect(after?.mtime).toBe(tomb?.mtime);

		// 복구는 만료 — unrecoverable
		const restorer = new RestoreManager(a.ctx, a.uploader);
		expect(await restorer.restore("doc.md")).toBe("unrecoverable");
		const listed = await restorer.listDeleted();
		expect(listed.find((d) => d.dbPath === "doc.md")?.recoverable).toBe(false);

		// 부활 판정 불변: 다른 내용으로 재생성하면(시계와 무관하게 해시로) 부활한다
		const recreated = a.vault.seed("doc.md", "new content");
		recreated.stat.mtime = Date.now() - 60_000; // 과거 mtime이어도
		expect(await a.uploader.uploadPath("doc.md")).toBe("uploaded");

		// 멱등: 다시 스윕해도 재처리 없음
		expect(await sweepTombstones(a.ctx, 30)).toBe(0);
	});
});
