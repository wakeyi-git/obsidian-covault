// 이벤트 구동 동기화(통합 변경 감지, 평가 H-6) — MirrorSync transport:"event"를 실엔진으로 검증.
// _db_updates watcher 자체는 모킹 테스트(DbUpdatesWatcher.test.ts)로, 여기선 syncOnce/requestPush가
// 실제 replication·vault 반영으로 이어지는지를 본다.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { MirrorSync } from "../../src/core/sync/MirrorSync";
import { noteId, NoteDoc } from "../../src/core/model/types";

function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
			setTimeout(tick, 10);
		};
		tick();
	});
}

describe("이벤트 구동 동기화 (H-6)", () => {
	let cluster: Cluster;
	let sync: MirrorSync | null = null;
	afterEach(async () => {
		await sync?.stop();
		sync = null;
		cluster?.dispose();
	});

	it("원격 변경 → syncOnce → vault 반영, 로컬 쓰기 → notifyLocalWrite → push로 원격 도달", async () => {
		cluster = new Cluster();
		const remote = cluster.device({ deviceId: "r", role: "manager", remoteDb: "mirror_e1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_e1" });

		sync = new MirrorSync(b.core, {
			memberId: "member_a",
			memberName: "학생A",
			localRoot: "",
			remoteDb: "mirror_e1",
			transport: () => "event",
		});
		await sync.start();
		expect(sync.status.state).toBe("idle"); // live replication 없이 대기

		// 1) 원격(다른 기기) 변경 → 감지 이벤트를 흉내내 syncOnce 호출 → pull + vault 반영
		remote.vault.seed("doc.md", "from remote");
		await remote.uploader.uploadPath("doc.md");
		await remote.push();
		await sync.syncOnce();
		await waitFor(() => b.vault.textOf("doc.md") === "from remote"); // LocalApplier 비동기 적용
		expect(sync.status.state).toBe("idle");

		// 2) 로컬 쓰기(실시간 스냅샷 경로) → notifyLocalWrite → requestPush 디바운스 → 원격 도달
		await sync.snapshotNote("doc.md", "local edit");
		sync.requestPush(0); // 테스트에선 디바운스 0으로 단축
		// push는 디바운스 후 직렬화 체인에서 비동기 실행 — 원격에 실제 도달할 때까지 폴링한다.
		const start = Date.now();
		let content: string | undefined;
		while (content !== "local edit") {
			if (Date.now() - start > 2000) throw new Error("push did not reach remote in time");
			await new Promise((r) => setTimeout(r, 20));
			await remote.pull();
			content = ((await remote.note("doc.md")) as NoteDoc | null)?.content;
		}
		expect(content).toBe("local edit");
	});

	it("fallbackToLive: 이벤트 모드 해제 시 notifyLocalWrite가 사라지고 live로 전환된다", async () => {
		cluster = new Cluster();
		const b = cluster.device({ deviceId: "b2", role: "member", remoteDb: "mirror_e2" });
		sync = new MirrorSync(b.core, {
			memberId: "member_a",
			memberName: "학생A",
			localRoot: "",
			remoteDb: "mirror_e2",
			transport: () => "event",
		});
		await sync.start();
		expect(sync.ctx.notifyLocalWrite).toBeTypeOf("function");
		sync.fallbackToLive();
		expect(sync.ctx.notifyLocalWrite).toBeUndefined();
		// live 전환 후에도 동기화는 동작(replication이 붙음) — 상태가 error가 아니어야 한다
		expect(sync.status.state).not.toBe("error");
	});
});
