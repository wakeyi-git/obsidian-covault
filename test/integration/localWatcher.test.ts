// LocalWatcher 이벤트 경로 — 평가 P1-1(테스트 #4). 하니스 vault가 이제 create/modify/rename/delete를
// 실제 Obsidian처럼 발화하므로, 동기화 진입점인 LocalWatcher(디바운스 → 업로드/tombstone)를 통합 검증한다.
// 기존엔 InMemoryVault.on()이 no-op이라 이 경로(226줄)가 어떤 테스트로도 재현되지 않았다(0.121.0 watcher 회귀 영역).
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { LocalWatcher } from "../../src/core/sync/LocalWatcher";
import { assetId, noteId, rtPartId } from "../../src/core/model/types";
import { TFolder } from "obsidian";

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

	it("폴더 rename 이벤트 1건만으로 하위 노트·첨부 전체를 옛 prefix tombstone + 새 prefix 업로드", async () => {
		const d = startWatcher();
		await d.vault.createFolder("옛폴더");
		await d.vault.createFolder("옛폴더/하위");
		await d.vault.create("옛폴더/메모.md", "내용");
		await d.vault.createBinary("옛폴더/하위/그림.png", new Uint8Array([1, 2, 3]).buffer);
		await settle();

		const folder = d.vault.getAbstractFileByPath("옛폴더");
		expect(folder).toBeInstanceOf(TFolder);
		d.vault.rename(folder!, "새폴더");
		await settle(100);

		expect((await d.ctx.pouch.get<any>(noteId("옛폴더/메모.md")))?.deleted).toBe(true);
		expect((await d.ctx.pouch.get<any>(assetId("옛폴더/하위/그림.png")))?.deleted).toBe(true);
		expect((await d.ctx.pouch.get<any>(noteId("새폴더/메모.md")))?.content).toBe("내용");
		expect((await d.ctx.pouch.get<any>(assetId("새폴더/하위/그림.png")))?.deleted).toBeFalsy();
	});

	it("폴더 생성 직후 debounce 전에 rename해도 옛 pending을 정리하고 새 경로를 업로드", async () => {
		const d = startWatcher();
		await d.vault.createFolder("빠른옛폴더");
		await d.vault.create("빠른옛폴더/메모.md", "내용");
		const folder = d.vault.getAbstractFileByPath("빠른옛폴더");
		d.vault.rename(folder!, "빠른새폴더");
		await settle(100);
		expect(await d.ctx.pouch.get<any>(noteId("빠른옛폴더/메모.md"))).toBeNull();
		expect((await d.ctx.pouch.get<any>(noteId("빠른새폴더/메모.md")))?.content).toBe("내용");
		expect(d.ctx.isPending("빠른옛폴더/메모.md")).toBe(false);
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

describe("읽기전용 공유 공간 삭제 게이팅", () => {
	let cluster: Cluster;
	let watcher: LocalWatcher | undefined;
	afterEach(() => {
		watcher?.stop();
		watcher = undefined;
		cluster?.dispose();
	});

	// ctx.remoteDb(공유 공간) != settings.remoteDb(개인 mirror) + role member → isReadOnlyShared 후보.
	function startReadOnlyMember() {
		cluster = new Cluster();
		const d = cluster.device({
			deviceId: "m",
			role: "member",
			remoteDb: "share_x",
			localRoot: "",
			settings: { remoteDb: "mirror_self", debounceMs: 5 },
		});
		watcher = new LocalWatcher(d.ctx, d.uploader);
		watcher.start();
		return d;
	}

	it("비참여자 삭제는 tombstone 대신 라이브 사본을 복원한다", async () => {
		const d = startReadOnlyMember();
		// 아직 읽기전용 아님 → 정상 업로드로 라이브 노트 생성.
		const file = await d.vault.create("공유노트.md", "내용");
		await settle();
		expect((await d.ctx.pouch.get<any>(noteId("공유노트.md")))?.content).toBe("내용");
		// 읽기전용 전환 후 삭제 — rtpart 없음 → 비참여자 → 복원.
		d.settings.sharedReadOnly = true;
		await d.vault.trash(file, false);
		await settle();
		expect(d.ctx.getFile("공유노트.md")).not.toBeNull(); // vault에 복원됨
		const doc = await d.ctx.pouch.get<any>(noteId("공유노트.md"));
		expect(doc?.deleted).toBeFalsy(); // tombstone 만들지 않음
	});

	it("편집(modify)은 올리지 않고 정본으로 복원한다(기기 보관 아님)", async () => {
		const d = startReadOnlyMember();
		const file = await d.vault.create("공유노트.md", "정본");
		await settle();
		d.settings.sharedReadOnly = true;
		await d.vault.process(file, () => "구성원이 바꿈");
		await settle();
		expect(await d.ctx.readVaultFile("공유노트.md")).toBe("정본"); // vault 원복
		const doc = await d.ctx.pouch.get<any>(noteId("공유노트.md"));
		expect(doc?.content).toBe("정본"); // 업로드 안 됨(pouch 정본 유지)
	});

	it("구성원이 새로 만든 파일은(정본 없음) 제거된다", async () => {
		const d = startReadOnlyMember();
		d.settings.sharedReadOnly = true;
		await d.vault.create("구성원작성.md", "임의");
		await settle();
		expect(d.ctx.getFile("구성원작성.md")).toBeNull(); // vault에서 제거
		const doc = await d.ctx.pouch.get<any>(noteId("구성원작성.md"));
		expect(doc).toBeNull(); // 업로드 안 됨
	});

	it("참여자로 지정돼도 삭제는 복원된다(관리자만 삭제 가능)", async () => {
		const d = startReadOnlyMember();
		const file = await d.vault.create("공유노트.md", "내용");
		await settle();
		// 이 파일의 실시간 참여자로 지정(편집은 가능) + 읽기전용 전환.
		await d.ctx.pouch.put({
			_id: rtPartId("공유노트.md"),
			type: "rtpart",
			schemaVersion: 1,
			workspaceId: "class_test",
			dbPath: "공유노트.md",
			memberIds: ["m"],
			updatedAtMs: 1,
			updatedBy: "m",
		} as any);
		d.settings.sharedReadOnly = true;
		await d.vault.trash(file, false);
		await settle();
		expect(d.ctx.getFile("공유노트.md")).not.toBeNull(); // 복원됨
		const doc = await d.ctx.pouch.get<any>(noteId("공유노트.md"));
		expect(doc?.deleted).toBeFalsy(); // 참여자여도 삭제(tombstone) 안 됨
	});

	it("폴더 rename은 폴더 전체를 원래 경로로 되돌리고 DB에는 쓰지 않는다", async () => {
		const d = startReadOnlyMember();
		await d.vault.createFolder("공유폴더");
		await d.vault.create("공유폴더/노트.md", "정본");
		await settle();
		d.settings.sharedReadOnly = true;
		const folder = d.vault.getAbstractFileByPath("공유폴더");
		d.vault.rename(folder!, "바꾼폴더");
		await settle();
		expect(d.vault.has("공유폴더/노트.md")).toBe(true);
		expect(d.vault.has("바꾼폴더/노트.md")).toBe(false);
		expect((await d.ctx.pouch.get<any>(noteId("공유폴더/노트.md")))?.deleted).toBeFalsy();
		expect(await d.ctx.pouch.get<any>(noteId("바꾼폴더/노트.md"))).toBeNull();
	});
});
