// 평가 보고서(docs/evaluation-report-2026-06-11.md) 조치 검증.
// H-2(pending 참조 카운트) · M-1(원격 삭제 vs pending 편집) · M-3/M-4(down 방향 기준선·복원)
// M-5(tombstone 부활의 해시 판정) · M-11(manifest 증분 스캔) · L-2(충돌 이력 플래그).
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { noteId } from "../../src/core/model/types";
import { listDeleteModify } from "../../src/core/sync/deleteModifyQueue";
import { LinkManifestDoc, MANIFEST_ID } from "../../src/core/sync/LinkManifest";

describe("평가 조치 회귀 방지", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("H-2: pending은 참조 카운트 — 첫 업로드 완료가 두 번째 편집의 보호 표식을 지우지 않는다", () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_s1" });

		a.ctx.markPending("doc.md"); // 편집1(업로드 진행 중)
		a.ctx.markPending("doc.md"); // 편집2(디바운스 대기)
		a.ctx.clearPending("doc.md"); // 편집1 업로드 완료
		expect(a.ctx.isPending("doc.md")).toBe(true); // 편집2가 아직 보호 중
		a.ctx.clearPending("doc.md");
		expect(a.ctx.isPending("doc.md")).toBe(false);
		a.ctx.clearPending("doc.md"); // 초과 해제는 무해(음수 금지)
		expect(a.ctx.isPending("doc.md")).toBe(false);
	});

	it("M-1: 업로드 대기 중인 편집이 있는 파일의 원격 삭제는 보류 + 삭제/수정 충돌 큐 등록", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("doc.md", "v1");
		await a.uploader.uploadPath("doc.md");
		await a.push();
		await b.pull();
		b.vault.seed("doc.md", "v1");

		// b가 편집(업로드 대기) ↔ a가 같은 파일을 삭제
		b.vault.seed("doc.md", "b's last edit");
		b.ctx.markPending("doc.md");
		await a.uploader.tombstonePath("doc.md");
		await a.push();
		await b.pull();

		const tomb = await b.ctx.pouch.getWithConflicts<any>(noteId("doc.md"));
		expect(tomb?.deleted).toBe(true);
		const result = await b.applier.applyDoc(tomb);

		expect(result).toBe("skipped-pending"); // 삭제 보류 — 편집이 .trash로 사라지지 않는다
		expect(b.vault.textOf("doc.md")).toBe("b's last edit");
		const queued = await listDeleteModify(b.ctx.pouch);
		expect(queued.map((q) => q.dbPath)).toContain("doc.md");
	});

	it("M-5: 기기 간 시계가 어긋나도 내용이 다른 재생성 파일은 tombstone을 되살린다(해시 판정)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("doc.md", "v1");
		await a.uploader.uploadPath("doc.md");
		await a.push();
		await b.pull();

		await a.uploader.tombstonePath("doc.md");
		await a.push();
		await b.pull();

		// 잔존 사본(삭제 전과 동일 내용 + 과거 mtime) → 부활시키지 않는다
		const leftover = b.vault.seed("doc.md", "v1");
		leftover.stat.mtime = Date.now() - 60_000;
		expect(await b.uploader.uploadPath("doc.md")).toBe("skipped-deleted");

		// 재생성(다른 내용) — 삭제 기기 시계가 앞서 mtime이 과거여도 내용이 다르면 부활
		const recreated = b.vault.seed("doc.md", "v2 recreated");
		recreated.stat.mtime = Date.now() - 60_000;
		expect(await b.uploader.uploadPath("doc.md")).toBe("uploaded");
	});

	it("M-3/M-4: '다운로드만'은 기준선을 보존하고, 내 기기 문서의 유실 파일도 복원한다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("keep.md", "content");
		await a.fullSync.run("both"); // 기준선 기록
		const before = await a.ctx.pouch.get<LinkManifestDoc>(MANIFEST_ID);
		expect(before?.paths["keep.md"]).toBeTruthy();

		// 플러그인 꺼진 사이의 실수 삭제를 흉내: tombstone 없이 vault에서만 제거
		const f = a.ctx.getFile("keep.md");
		await a.vault.trash(f!, false);
		expect(a.vault.has("keep.md")).toBe(false);

		await a.fullSync.run("down");

		// M-4: 마지막 수정자가 본인 기기여도 전체 다운로드가 복원한다
		expect(a.vault.textOf("keep.md")).toBe("content");
		// M-3: down은 기준선을 덮어쓰지 않는다(삭제 증거 보존)
		const after = await a.ctx.pouch.get<LinkManifestDoc>(MANIFEST_ID);
		expect(after?.updatedAt).toBe(before?.updatedAt);
	});

	it("M-11: manifest 항목에 stat(mtime/size)이 기록되고, 변경 없는 파일은 재기록 시 재사용된다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("note.md", "hello");
		await a.fullSync.run("both");
		const m1 = await a.ctx.pouch.get<LinkManifestDoc>(MANIFEST_ID);
		const e1 = m1?.paths["note.md"];
		const stat = a.ctx.getFile("note.md")!.stat;
		expect(e1?.mtime).toBe(stat.mtime);
		expect(e1?.size).toBe(stat.size);

		// 변경 없이 다시 동기화 → 항목 동일(재사용), 증분 스킵 로그 발생
		await a.fullSync.run("both");
		const m2 = await a.ctx.pouch.get<LinkManifestDoc>(MANIFEST_ID);
		expect(m2?.paths["note.md"]).toEqual(e1);
		expect(a.log.some((l) => l.message.includes("증분 스캔"))).toBe(true);

		// 파일 수정 → 항목 갱신(새 rev·hash·mtime)
		const file = a.ctx.getFile("note.md")!;
		await a.vault.process(file, () => "hello world");
		await a.fullSync.run("both");
		const m3 = await a.ctx.pouch.get<LinkManifestDoc>(MANIFEST_ID);
		expect(m3?.paths["note.md"]?.hash).not.toBe(e1?.hash);
		expect(m3?.paths["note.md"]?.size).toBe(a.ctx.getFile("note.md")!.stat.size);
	});

	it("L-2: _충돌/ 사본을 지워도 충돌 이력 플래그가 남아 preserveLocal 근거가 유지된다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		// 분기 편집으로 충돌 생성(conflictPreserve.test.ts와 동일 패턴)
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
		const doc = await b.ctx.pouch.getWithConflicts<any>(noteId("c.md"));
		expect(await b.applier.applyDoc(doc)).toBe("conflict");

		// 사용자가 _충돌/ 사본을 직접 삭제해도 이력 플래그는 유지
		const copyPath = b.ctx.conflictLocalPath("c.md");
		await b.vault.trash(b.ctx.getFile(copyPath)!, false);
		expect(await b.conflicts.hadConflict("c.md")).toBe(true);

		// 해소/정리되면 플래그도 내려간다
		await b.conflicts.cleanupCopy("c.md");
		expect(await b.conflicts.hadConflict("c.md")).toBe(false);
	});
});
