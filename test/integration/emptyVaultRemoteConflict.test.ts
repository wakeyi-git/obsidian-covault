// 빈 볼트 첫 동기화에서 '이미 원격에 미해소 충돌(여러 리프)이 있는 문서'를 받는 경우의 회귀 테스트.
// 과거: 보존할 로컬이 없는데도 preserve-local 분기를 타서 노트가 정상 경로에 안 생기고 _충돌/ 사본만
// 만들어지며 "충돌 보류(preserve-local)" 로그가 떴다. 이제는 winner를 정상 경로에 적용하고 분기 리프만
// _충돌/에 꺼낸다(노트 즉시 표시 + 데이터 손실 없음 + 정확한 로그).
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { noteId } from "../../src/core/model/types";

describe("빈 볼트 첫 동기화 — 원격 미해소 충돌", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("winner를 정상 경로에 적용하고 분기 리프를 _충돌/에 보존하며 preserve-local 로그는 쓰지 않는다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		// 공유 원격에 미해소 충돌 문서를 만든다(서로 다른 두 리프, 승자=a의 gen3).
		a.vault.seed("c.md", "base");
		await a.uploader.uploadPath("c.md");
		await a.push();
		await b.pull();
		b.vault.seed("c.md", "B-edit");
		await b.uploader.uploadPath("c.md");
		await b.push(); // b의 분기 리프도 원격에 올린다
		a.vault.seed("c.md", "A-edit1");
		await a.uploader.uploadPath("c.md");
		a.vault.seed("c.md", "A-edit2");
		await a.uploader.uploadPath("c.md");
		await a.push();

		// c: 같은 원격에 처음 붙는 빈 볼트.
		const c = cluster.device({ deviceId: "c", role: "member", remoteDb: "mirror_s1" });
		await c.pull();
		const doc = await c.ctx.pouch.getWithConflicts<any>(noteId("c.md"));
		expect(doc?._conflicts?.length).toBeGreaterThan(0); // 받자마자 미해소 충돌

		const result = await c.applier.applyDoc(doc);

		expect(result).toBe("conflict");
		// 노트가 정상 경로에 winner 내용으로 즉시 나타난다.
		expect(c.vault.textOf("c.md")).toBe("A-edit2");
		// 분기 리프는 _충돌/에 보존 → '충돌 목록'에서 해소 가능.
		const conflictPath = c.ctx.conflictLocalPath("c.md");
		expect(c.vault.textOf(conflictPath)).toBe("B-edit");
		// 보존할 로컬이 없었으므로 preserve-local 로그가 아니라 '원격 미해소 충돌' 로그.
		const warns = c.warnings();
		expect(warns.some((w) => w.includes("preserve-local"))).toBe(false);
		expect(warns.some((w) => w.includes("원격 미해소 충돌"))).toBe(true);

		// 충돌 목록에 1건으로 나열(로컬=winner, 원격=분기 리프).
		const rows = await c.conflicts.list();
		expect(rows).toHaveLength(1);
		expect(rows[0].localContent).toBe("A-edit2");
		expect(rows[0].remoteContent).toBe("B-edit");
	});

	it("재적용해도 _충돌/ 사본을 지우지 않고 충돌 상태를 유지한다(다음 주기 멱등)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s2" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s2" });

		a.vault.seed("d.md", "base");
		await a.uploader.uploadPath("d.md");
		await a.push();
		await b.pull();
		b.vault.seed("d.md", "B");
		await b.uploader.uploadPath("d.md");
		await b.push();
		a.vault.seed("d.md", "A1");
		await a.uploader.uploadPath("d.md");
		a.vault.seed("d.md", "A2");
		await a.uploader.uploadPath("d.md");
		await a.push();

		const c = cluster.device({ deviceId: "c", role: "member", remoteDb: "mirror_s2" });
		await c.pull();
		const doc = await c.ctx.pouch.getWithConflicts<any>(noteId("d.md"));
		await c.applier.applyDoc(doc);
		// 같은 문서를 다시 적용(폴링/재시작으로 흔히 일어남).
		const doc2 = await c.ctx.pouch.getWithConflicts<any>(noteId("d.md"));
		const result = await c.applier.applyDoc(doc2);

		expect(result).toBe("conflict"); // skipped-same으로 _충돌/를 정리하지 않는다
		expect(c.vault.textOf("d.md")).toBe("A2");
		expect(c.vault.textOf(c.ctx.conflictLocalPath("d.md"))).toBe("B"); // 사본 유지
	});
});
