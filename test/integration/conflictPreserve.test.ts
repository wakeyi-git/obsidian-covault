// P1 시나리오 3: 충돌 보존(preserve-local). 로컬 편집을 덮지 않고 원격본을 _충돌/에 보존하는지.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { noteId } from "../../src/core/model/types";

describe("충돌 보존 (preserve-local)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("업로드 대기(pending) 중 다른 기기의 원격 변경을 받으면 로컬 유지 + 원격본을 _충돌/에 보존", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		// a가 원격에 "remote edit"을 올린다.
		a.vault.seed("doc.md", "remote edit");
		await a.uploader.uploadPath("doc.md");
		await a.push();

		// b는 같은 파일을 로컬에서 다르게 편집해 업로드 대기 상태로 둔다.
		b.vault.seed("doc.md", "local edit");
		b.ctx.markPending("doc.md");

		// b가 원격 변경을 받아 적용 시도
		await b.pull();
		const incoming = await b.ctx.pouch.getWithConflicts<any>(noteId("doc.md"));
		const result = await b.applier.applyDoc(incoming);

		expect(result).toBe("skipped-pending");
		// 로컬은 유지
		expect(b.vault.textOf("doc.md")).toBe("local edit");
		// 원격본은 _충돌/에 보존
		const conflictPath = b.ctx.conflictLocalPath("doc.md");
		expect(b.vault.textOf(conflictPath)).toBe("remote edit");
	});

	it("양쪽 분기 편집(_conflicts)이면 로컬 유지하고 원격본을 _충돌/에 꺼내며 'conflict' 반환", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		// 공통 조상
		a.vault.seed("c.md", "base");
		await a.uploader.uploadPath("c.md");
		await a.push();
		await b.pull();

		// b: 1회 편집(gen2). 푸시하지 않음.
		b.vault.seed("c.md", "B-edit");
		await b.uploader.uploadPath("c.md");

		// a: 2회 편집(gen3)으로 더 높은 세대를 만들어 승자를 결정적으로 a쪽으로.
		a.vault.seed("c.md", "A-edit1");
		await a.uploader.uploadPath("c.md");
		a.vault.seed("c.md", "A-edit2");
		await a.uploader.uploadPath("c.md");
		await a.push();

		// b가 원격을 받으면 _conflicts 분기 발생(b gen2 vs a gen3, 승자 a).
		await b.pull();
		const doc = await b.ctx.pouch.getWithConflicts<any>(noteId("c.md"));
		expect(doc?._conflicts?.length).toBeGreaterThan(0);

		const result = await b.applier.applyDoc(doc);

		expect(result).toBe("conflict");
		// 로컬(라이브) 유지
		expect(b.vault.textOf("c.md")).toBe("B-edit");
		// 원격(라이브와 다른) 리프를 _충돌/에 보존
		const conflictPath = b.ctx.conflictLocalPath("c.md");
		expect(b.vault.textOf(conflictPath)).toBe("A-edit2");

		// 해소: '두 버전 보관(원격 최종)' → 로컬을 사본으로 보존하고 원격을 최종본으로.
		await b.conflicts.resolve("c.md", "both-remote");
		expect(b.vault.textOf("c.md")).toBe("A-edit2"); // 최종 = 원격
		expect(b.vault.textOf("c (충돌본).md")).toBe("B-edit"); // 로컬 사본 보존
		// _conflicts collapse 확인
		const after = await b.ctx.pouch.getWithConflicts<any>(noteId("c.md"));
		expect(after?._conflicts ?? []).toHaveLength(0);
	});
});
