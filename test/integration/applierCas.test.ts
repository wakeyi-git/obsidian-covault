// 평가 D-2 회귀 — applier의 읽기→쓰기 사이에 끼어든 로컬 편집을 compare-and-swap이 보호하는지.
// 레이스는 guard.mark(쓰기 직전 호출) 훅에서 "사용자 저장"을 주입해 결정적으로 재현한다.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { NoteDoc } from "../../src/core/model/types";
import { sha256 } from "../../src/core/hash/hash";

describe("applier compare-and-swap (D-2)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("읽기 이후 끼어든 사용자 편집을 덮지 않는다(skipped-pending → 다음 변경에서 재평가)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_cas1" });

		a.vault.seed("doc.md", "v1");
		await a.uploader.uploadPath("doc.md");

		// 다른 기기의 원격 갱신 문서(충돌 없음 — 깨끗한 적용 경로로 진입).
		const remote: NoteDoc = {
			...(await a.ctx.pouch.get<NoteDoc>("note:doc.md"))!,
			content: "remote v2",
			contentHash: await sha256("remote v2"),
			version: 2,
			lastModifiedDeviceId: "other-device",
		};

		// applyDoc이 로컬을 읽은 뒤(쓰기 직전 guard.mark 시점) 사용자 저장이 끼어드는 상황을 주입.
		const guard = a.ctx.guard;
		const origMark = guard.mark.bind(guard);
		let armed = true;
		guard.mark = (localPath: string, hash: string) => {
			if (armed && localPath === "doc.md") {
				armed = false;
				a.vault.seed("doc.md", "user edit during apply"); // watcher pending에 아직 안 잡힌 저장
			}
			origMark(localPath, hash);
		};

		const res = await a.applier.applyDoc(remote);
		// 이전(무조건 쓰기)이라면 사용자 편집이 보존 없이 "remote v2"로 덮였다.
		expect(res).toBe("skipped-pending");
		expect(await a.ctx.readVaultFile("doc.md")).toBe("user edit during apply");
	});

	it("끼어든 변경이 없으면 정상 적용된다(CAS가 일반 경로를 막지 않음)", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "member", remoteDb: "mirror_cas2" });

		a.vault.seed("doc.md", "v1");
		await a.uploader.uploadPath("doc.md");
		const remote: NoteDoc = {
			...(await a.ctx.pouch.get<NoteDoc>("note:doc.md"))!,
			content: "remote v2",
			contentHash: await sha256("remote v2"),
			version: 2,
			lastModifiedDeviceId: "other-device",
		};

		const res = await a.applier.applyDoc(remote);
		expect(res).toBe("applied");
		expect(await a.ctx.readVaultFile("doc.md")).toBe("remote v2");
	});
});
