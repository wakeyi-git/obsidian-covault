// P1 시나리오 4: 방향성 명령(업로드만/다운로드만)이 의도한 방향으로만 replication 하는지.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";

describe("동기화 방향성 (up/down)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("'업로드만'은 로컬을 원격에 올리되 원격 변경을 vault로 끌어오지 않는다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });
		const observer = cluster.device({ deviceId: "obs", role: "member", remoteDb: "mirror_s1" });

		// 원격에는 b가 올린 파일이 이미 있다.
		b.vault.seed("fromB.md", "b-content");
		await b.uploader.uploadPath("fromB.md");
		await b.push();

		// a는 자기 파일만 두고 '업로드만' 실행.
		a.vault.seed("fromA.md", "a-content");
		await a.sync("up");

		// a는 원격의 fromB를 받지 않아야 한다.
		expect(a.vault.has("fromB.md")).toBe(false);
		expect(await a.note("fromB.md")).toBeNull();

		// a의 파일은 원격에 반영된다(observer가 pull해 확인).
		await observer.pull();
		expect((await observer.note("fromA.md"))?.content).toBe("a-content");
	});

	it("'다운로드만'은 원격을 vault로 받되 로컬 전용 변경을 원격에 밀지 않는다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "manager", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "member", remoteDb: "mirror_s1" });
		const observer = cluster.device({ deviceId: "obs", role: "member", remoteDb: "mirror_s1" });

		// 원격에 b의 파일.
		b.vault.seed("fromB.md", "b-content");
		await b.uploader.uploadPath("fromB.md");
		await b.push();

		// a는 로컬 전용 파일을 두고 '다운로드만'.
		a.vault.seed("localOnly.md", "secret-local");
		await a.sync("down");

		// 원격 파일은 vault로 내려와야 하고
		expect(a.vault.has("fromB.md")).toBe(true);

		// 로컬 전용 파일은 원격에 올라가지 않아야 한다.
		await observer.pull();
		expect(await observer.note("localOnly.md")).toBeNull();
		// (다운로드만은 업로드 단계가 없어 로컬 DB에도 기록되지 않음)
		expect(await a.note("localOnly.md")).toBeNull();
	});
});
