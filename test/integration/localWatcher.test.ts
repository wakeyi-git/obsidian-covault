// LocalWatcher 이벤트 경로 — 평가 P1-1(테스트 #4). 하니스 vault가 이제 create/modify/rename/delete를
// 실제 Obsidian처럼 발화하므로, 동기화 진입점인 LocalWatcher(디바운스 → 업로드/tombstone)를 통합 검증한다.
// 기존엔 InMemoryVault.on()이 no-op이라 이 경로(226줄)가 어떤 테스트로도 재현되지 않았다(0.121.0 watcher 회귀 영역).
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { LocalWatcher } from "../../src/core/sync/LocalWatcher";
import { noteId } from "../../src/core/model/types";

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("LocalWatcher 이벤트 → 업로드/tombstone (P1-1)", () => {
	let cluster: Cluster;
	let watcher: LocalWatcher | undefined;
	afterEach(() => {
		watcher?.stop();
		watcher = undefined;
		cluster?.dispose();
	});

	function startWatcher() {
		cluster = new Cluster();
		const d = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_s1", localRoot: "", settings: { debounceMs: 5 } });
		watcher = new LocalWatcher(d.ctx, d.uploader);
		watcher.start(); // onLayoutReady는 하니스에서 즉시 실행 → 리스너 등록
		return d;
	}

	it("create 이벤트 → 디바운스 후 노트 업로드", async () => {
		const d = startWatcher();
		await d.vault.create("메모.md", "안녕하세요");
		await settle();
		const doc = await d.ctx.pouch.get<any>(noteId("메모.md"));
		expect(doc?.content).toBe("안녕하세요");
		expect(doc?.deleted).toBeFalsy();
	});

	it("modify 이벤트 → 변경 내용으로 재업로드", async () => {
		const d = startWatcher();
		const file = await d.vault.create("메모.md", "v1");
		await settle();
		await d.vault.process(file, () => "v2-수정");
		await settle();
		const doc = await d.ctx.pouch.get<any>(noteId("메모.md"));
		expect(doc?.content).toBe("v2-수정");
	});

	it("delete 이벤트 → tombstone(deleted=true)", async () => {
		const d = startWatcher();
		const file = await d.vault.create("메모.md", "지울 내용");
		await settle();
		await d.vault.trash(file, false);
		await settle();
		const doc = await d.ctx.pouch.get<any>(noteId("메모.md"));
		expect(doc?.deleted).toBe(true);
	});

	it("rename 이벤트 → 옛 경로 tombstone + 새 경로 업로드", async () => {
		const d = startWatcher();
		const file = await d.vault.create("옛이름.md", "내용");
		await settle();
		d.vault.rename(file, "새이름.md");
		await settle();
		const oldDoc = await d.ctx.pouch.get<any>(noteId("옛이름.md"));
		const newDoc = await d.ctx.pouch.get<any>(noteId("새이름.md"));
		expect(oldDoc?.deleted).toBe(true);
		expect(newDoc?.content).toBe("내용");
		expect(newDoc?.deleted).toBeFalsy();
	});

	it("stop() 후에는 이벤트를 무시한다(리스너 해제)", async () => {
		const d = startWatcher();
		watcher!.stop();
		await d.vault.create("무시.md", "내용");
		await settle();
		const doc = await d.ctx.pouch.get<any>(noteId("무시.md"));
		expect(doc).toBeNull();
	});
});
