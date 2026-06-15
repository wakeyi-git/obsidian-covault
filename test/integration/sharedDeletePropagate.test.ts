// 재현/회귀: 관리자가 공동 공간(읽기전용 공유)에서 삭제한 파일·폴더가 구성원에게 전파되는가.
// 사용자 보고: 폴더 삭제가 전파되지 않고 파일이 원래 위치에 남으며, 읽기전용이라 구성원이 지우지도 못함.
// 원인: Obsidian은 폴더 삭제 시 폴더 1건의 delete 이벤트만 내고 내부 파일별 이벤트는 안 낸다 →
// LocalWatcher가 폴더 안 파일들을 tombstone하지 못했다. handleFolderDelete로 보강.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster, settle } from "../harness/env";
import { LocalApplier } from "../../src/core/sync/LocalApplier";
import { LocalWatcher } from "../../src/core/sync/LocalWatcher";
import { listVaultOrphans, tombstoneVaultOrphans } from "../../src/core/sync/orphanRepair";
import { noteId } from "../../src/core/model/types";

describe("공동 공간 삭제 전파 (관리자 → 읽기전용 구성원)", () => {
	let cluster: Cluster;
	const stops: Array<() => void> = [];
	afterEach(async () => {
		for (const s of stops) s();
		stops.length = 0;
		await cluster?.dispose();
	});

	function setup() {
		cluster = new Cluster();
		const mgr = cluster.device({ deviceId: "mgr", role: "manager", remoteDb: "share_x", localRoot: "" });
		const mem = cluster.device({
			deviceId: "mem",
			role: "member",
			remoteDb: "share_x",
			localRoot: "",
			settings: { remoteDb: "mirror_self", sharedReadOnly: true, debounceMs: 5 },
		});
		// 구성원 측 실엔진: 원격→vault 적용기 + 읽기전용 되돌림 watcher 동시 가동(프로덕션과 동일).
		const memLa = mem.makeLocalApplier();
		memLa.start();
		const memLw = new LocalWatcher(mem.ctx, mem.uploader);
		memLw.start();
		// 관리자 측: 폴더 삭제를 tombstone으로 바꾸는 watcher.
		const mgrLw = new LocalWatcher(mgr.ctx, mgr.uploader);
		mgrLw.start();
		stops.push(() => memLa.stop(), () => memLw.stop(), () => mgrLw.stop());
		return { mgr, mem };
	}

	it("관리자가 삭제한 단일 공유 파일은 구성원 vault에서 사라진다(회귀)", async () => {
		const { mgr, mem } = setup();
		await mgr.vault.create("공유.md", "내용");
		await mgr.uploader.uploadPath("공유.md");
		await mgr.push();
		await mem.pull();
		await settle();
		expect(mem.ctx.getFile("공유.md")).not.toBeNull();

		await mgr.uploader.tombstonePath("공유.md");
		await mgr.push();
		await mem.pull();
		await settle(120);
		expect(mem.ctx.getFile("공유.md")).toBeNull();
	});

	it("관리자가 폴더를 삭제하면 그 안 파일들이 tombstone되어 구성원 vault에서 사라진다", async () => {
		const { mgr, mem } = setup();
		// 관리자가 폴더 + 파일 2개 생성 → 업로드.
		await mgr.vault.createFolder("자료");
		await mgr.vault.create("자료/a.md", "A");
		await mgr.vault.create("자료/b.md", "B");
		await mgr.uploader.uploadPath("자료/a.md");
		await mgr.uploader.uploadPath("자료/b.md");
		await mgr.push();

		// 구성원이 수신 → 두 파일 모두 vault에 존재.
		await mem.pull();
		await settle();
		expect(mem.ctx.getFile("자료/a.md")).not.toBeNull();
		expect(mem.ctx.getFile("자료/b.md")).not.toBeNull();

		// 관리자가 폴더 삭제(파일별 이벤트 없음) → handleFolderDelete가 두 파일을 tombstone해야 한다.
		await mgr.vault.deleteFolder("자료");
		await settle(60);
		expect((await mgr.note("자료/a.md"))?.deleted).toBe(true);
		expect((await mgr.note("자료/b.md"))?.deleted).toBe(true);

		// 전파 → 구성원 vault 원래 위치에서 두 파일 모두 사라져야 한다.
		await mgr.push();
		await mem.pull();
		await settle(150);
		expect(mem.ctx.getFile("자료/a.md")).toBeNull();
		expect(mem.ctx.getFile("자료/b.md")).toBeNull();
		// 회귀 가드: 정본 tombstone이 로컬에도 반영.
		expect((await mem.ctx.pouch.get<any>(noteId("자료/a.md")))?.deleted).toBe(true);
	});

	it("정합 복구: DB엔 살아있지만 vault엔 없는 파일을 tombstone해 전파한다(이미 깨진 상태 정리)", async () => {
		cluster = new Cluster();
		const mgr = cluster.device({ deviceId: "mgr", role: "manager", remoteDb: "share_x", localRoot: "" });
		const mem = cluster.device({
			deviceId: "mem",
			role: "member",
			remoteDb: "share_x",
			localRoot: "",
			settings: { remoteDb: "mirror_self", sharedReadOnly: true, debounceMs: 5 },
		});
		const memLa = mem.makeLocalApplier();
		memLa.start();
		stops.push(() => memLa.stop());

		// 정상 생성·업로드 → 구성원 수신.
		await mgr.vault.createFolder("자료");
		await mgr.vault.create("자료/x.md", "내용");
		await mgr.uploader.uploadPath("자료/x.md");
		await mgr.push();
		await mem.pull();
		await settle();
		expect(mem.ctx.getFile("자료/x.md")).not.toBeNull();

		// 깨진 상태 재현: watcher 없이 폴더 삭제 → vault 파일만 사라지고 pouch엔 live 문서가 남음(tombstone 없음).
		await mgr.vault.deleteFolder("자료");
		expect((await mgr.note("자료/x.md"))?.deleted).toBeFalsy(); // 여전히 live
		expect(mgr.ctx.getFile("자료/x.md")).toBeNull(); // vault엔 없음

		// 정합 복구: 고아 탐지 → tombstone.
		const orphans = await listVaultOrphans(mgr.ctx);
		expect(orphans).toContain("자료/x.md");
		const n = await tombstoneVaultOrphans(mgr.ctx, mgr.uploader, orphans);
		expect(n).toBeGreaterThan(0);
		expect((await mgr.note("자료/x.md"))?.deleted).toBe(true);

		// 전파 → 구성원 vault에서 제거.
		await mem.pull();
		await settle(150);
		expect(mem.ctx.getFile("자료/x.md")).toBeNull();
	});

	it("정합 복구: 관리자 로컬 DB가 뒤처져 원격에만 있는 파일은 pull 후에야 고아로 잡힌다", async () => {
		cluster = new Cluster();
		const mgr = cluster.device({ deviceId: "mgr", role: "manager", remoteDb: "share_x", localRoot: "" });
		const other = cluster.device({ deviceId: "other", role: "manager", remoteDb: "share_x", localRoot: "" });

		// 다른 기기가 공유 파일을 원격에 올림 — 관리자(mgr) vault·로컬 DB엔 아직 없음.
		await other.vault.create("외부.md", "내용");
		await other.uploader.uploadPath("외부.md");
		await other.push();

		// pull 전: mgr 로컬 DB에 없으니 고아로 안 잡힘(= 사용자의 "고아 없음" 상황).
		expect(await listVaultOrphans(mgr.ctx)).not.toContain("외부.md");

		// pull 후: live 문서가 로컬 DB로 들어오고 vault엔 없음 → 고아로 잡힘.
		await mgr.pull();
		expect(await listVaultOrphans(mgr.ctx)).toContain("외부.md");
		const n = await tombstoneVaultOrphans(mgr.ctx, mgr.uploader, ["외부.md"]);
		expect(n).toBe(1);
		expect((await mgr.note("외부.md"))?.deleted).toBe(true);
	});
});
