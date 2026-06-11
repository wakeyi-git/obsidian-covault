// rev 검증 put(평가 L-1·L-3) — 읽기→쓰기 사이에 끼어든 변경을 LWW로 덮지 않고 재평가하는지 검증.
// 레이스는 putWithRev 첫 호출 직전에 "끼어드는 변경"을 주입해 결정적으로 재현한다.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster, Device } from "../harness/env";
import { noteId, NoteDoc } from "../../src/core/model/types";
import { sha256 } from "../../src/core/hash/hash";

/** putWithRev 첫 호출 직전에 inject를 실행하는 스파이 설치(이후 호출은 원본 그대로). */
function injectBeforeFirstPut(dev: Device, targetId: string, inject: () => Promise<void>): void {
	const pouch = dev.ctx.pouch;
	const orig = pouch.putWithRev.bind(pouch);
	let armed = true;
	pouch.putWithRev = (async (doc: { _id: string }, rev: string | undefined) => {
		if (armed && doc._id === targetId) {
			armed = false;
			await inject(); // 끼어드는 원격 변경 — 이 뒤의 orig는 stale rev라 자연스럽게 "conflict"
		}
		return orig(doc as never, rev);
	}) as typeof pouch.putWithRev;
}

describe("rev 검증 put (L-1·L-3)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("L-1: 업로드 중 끼어든 교사 삭제 tombstone을 되살리지 않는다(재검증 후 skipped-deleted)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_r1" });

		a.vault.seed("doc.md", "v1");
		await a.uploader.uploadPath("doc.md");

		// 실시간 스냅샷 업로드가 진행되는 사이, 교사 삭제 tombstone이 pull로 도착하는 상황을 주입.
		injectBeforeFirstPut(a, noteId("doc.md"), async () => {
			const cur = await a.ctx.pouch.get<NoteDoc>(noteId("doc.md"));
			await a.ctx.pouch.put({
				...cur!,
				deleted: true,
				deletedByRole: "manager",
				deletedAt: new Date().toISOString(),
				version: (cur!.version ?? 0) + 1,
				lastModifiedDeviceId: "teacher-device",
			});
		});

		// 이전(LWW)이라면 tombstone 위에 새 내용이 덮여 교사 삭제가 부활했다.
		const res = await a.uploader.uploadContent("doc.md", "session content");
		expect(res).toBe("skipped-deleted");
		const doc = await a.ctx.pouch.get<NoteDoc>(noteId("doc.md"));
		expect(doc?.deleted).toBe(true); // 교사 삭제 유지
	});

	it("L-3: 해소 중 끼어든 새 원격 rev를 스냅샷·재평가한 뒤 확정한다(흔적 없는 덮어쓰기 방지)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_r2" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_r2" });

		// 분기 충돌 구성(conflictPreserve.test.ts 패턴)
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
		const before = await b.ctx.pouch.getWithConflicts<NoteDoc>(noteId("c.md"));
		expect(before?._conflicts?.length).toBeGreaterThan(0);

		// 해소(로컬 유지)가 collapse를 put하기 직전, 더 새로운 원격 rev가 도착하는 상황을 주입.
		injectBeforeFirstPut(b, noteId("c.md"), async () => {
			const cur = await b.ctx.pouch.get<NoteDoc>(noteId("c.md"));
			await b.ctx.pouch.put({
				...cur!,
				content: "newer remote",
				contentHash: await sha256("newer remote"),
				version: (cur!.version ?? 0) + 1,
				lastModifiedDeviceId: "a-device",
			});
		});

		await b.conflicts.resolve("c.md", "local");

		// 최종본은 사용자가 선택한 로컬, 충돌은 collapse됨
		const after = await b.ctx.pouch.getWithConflicts<NoteDoc>(noteId("c.md"));
		expect(after?.content).toBe("B-edit");
		expect(after?._conflicts ?? []).toHaveLength(0);
		// 끼어들었던 "newer remote"는 흔적 없이 사라지지 않고 버전 히스토리에 보존됨(재시도 시 스냅샷)
		const versions = await b.ctx.versions.list("c.md");
		expect(versions.some((v) => v.content === "newer remote")).toBe(true);
	});
});
