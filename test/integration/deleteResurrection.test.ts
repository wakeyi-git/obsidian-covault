// 삭제 부활(resurrection) 방지: 삭제 전에 다른 기기로 동기화된 사본이 삭제 후에도 남아
// 전체 동기화·실시간 스냅샷으로 tombstone을 되살리던 문제의 회귀 테스트.
import { describe, it, expect, afterEach, vi } from "vitest";
import { Cluster } from "../harness/env";

describe("삭제 부활 방지 (delete resurrection)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	/** A가 만들어 B까지 동기화된 파일을 A가 삭제하고, tombstone이 B의 로컬 DB에 도착한 상태를 만든다. */
	async function tombstoneSynced(aRole: "manager" | "member" = "manager") {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: aRole, remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("x.md", "v1");
		await a.sync("both");
		await b.sync("both"); // B vault에 사본 + 기준선
		expect(b.vault.has("x.md")).toBe(true);

		await a.vault.delete(a.vault.getAbstractFileByPath("x.md") as any);
		await a.sync("both"); // 기준선 비교로 tombstone + push
		expect((await a.note("x.md"))?.deleted).toBe(true);

		await b.pull(); // tombstone이 B 로컬 DB에 도착 — vault 사본은 아직 남아 있음(적용 전)
		expect(b.vault.has("x.md")).toBe(true);
		return { a, b };
	}

	it("잔존 사본은 전체 동기화에서 부활하지 않고 정책대로 정리된다", async () => {
		const { a, b } = await tombstoneSynced();

		await b.sync("both"); // 이전엔 upload()가 사본을 tombstone 위에 재업로드해 부활시켰다

		expect((await b.note("x.md"))?.deleted).toBe(true); // 부활 금지
		expect(b.vault.has("x.md")).toBe(false); // 보류된 삭제가 정책(archive)대로 적용됨

		await a.pull(); // 원격에서도 삭제 유지
		expect((await a.note("x.md"))?.deleted).toBe(true);
	});

	it("삭제 이후 실제로 다시 만든(수정한) 파일은 정상 업로드된다(재생성 보호)", async () => {
		const { a, b } = await tombstoneSynced();

		// B가 같은 경로에 새 파일을 만든다 — mtime이 tombstone보다 새것.
		const f = b.vault.getAbstractFileByPath("x.md") as any;
		await b.vault.delete(f);
		const fresh = b.vault.seed("x.md", "recreated");
		fresh.stat.mtime = Date.now() + 60_000;

		await b.sync("both");

		expect((await b.note("x.md"))?.deleted).toBe(false);
		expect((await b.note("x.md"))?.content).toBe("recreated");
		expect(b.vault.has("x.md")).toBe(true);
	});

	it("실시간 스냅샷(uploadContent)은 관리자 tombstone을 되살리지 않는다", async () => {
		const { b } = await tombstoneSynced("manager");

		const res = await b.uploader.uploadContent("x.md", "live content");

		expect(res).toBe("skipped-deleted");
		expect((await b.note("x.md"))?.deleted).toBe(true);
	});

	it("구성원 삭제 tombstone은 실시간 스냅샷이 복원할 수 있다(세션 보호 유지)", async () => {
		const { b } = await tombstoneSynced("member");

		const res = await b.uploader.uploadContent("x.md", "live content");

		expect(res).toBe("uploaded");
		expect((await b.note("x.md"))?.deleted).toBe(false);
	});

	it("세션 활성 파일의 관리자 삭제는 세션을 스냅샷 없이 종료하고 삭제를 적용한다", async () => {
		const { b } = await tombstoneSynced("manager");
		const ended: string[] = [];
		b.core.isRealtimeActive = (p) => p === "x.md";
		b.core.endRealtimeSession = vi.fn(async (p: string) => {
			ended.push(p);
			b.core.isRealtimeActive = () => false; // 종료 후 비활성
		});

		const doc = await b.note("x.md");
		const res = await b.applier.applyDoc(doc as any);

		expect(ended).toEqual(["x.md"]);
		expect(res).toBe("deleted");
		expect(b.vault.has("x.md")).toBe(false);
	});

	it("세션 활성 파일의 구성원 삭제는 보류된다(세션 보호)", async () => {
		const { b } = await tombstoneSynced("member");
		b.core.isRealtimeActive = (p) => p === "x.md";
		const end = vi.fn(async () => {});
		b.core.endRealtimeSession = end;

		const doc = await b.note("x.md");
		const res = await b.applier.applyDoc(doc as any);

		expect(res).toBe("skipped-pending");
		expect(end).not.toHaveBeenCalled();
		expect(b.vault.has("x.md")).toBe(true);
	});
});
