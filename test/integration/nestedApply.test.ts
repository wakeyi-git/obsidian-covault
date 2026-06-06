// P3-B: 조상 폴더가 없는 깊은 원격 파일을 적용할 때 중간 폴더를 재귀로 생성하는지.
// harness가 부모 폴더 부재를 강제(throw)하므로, 단일 단계 생성이면 이 테스트는 실패한다(회귀 가드).
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";

describe("중첩 경로 원격 적용 (재귀 부모 폴더 생성)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("조상이 전혀 없는 깊은 노트를 적용하면 a/b/c를 모두 생성하고 파일을 쓴다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "devA", role: "member", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "devB", role: "member", remoteDb: "mirror_s1" });

		// a: 깊은 경로 노트 업로드(seed가 조상 폴더를 등록).
		a.vault.seed("a/b/c/deep.md", "deep content");
		expect(await a.uploader.uploadPath("a/b/c/deep.md")).toBe("uploaded");
		await a.push();

		// b: vault가 비어 있음(조상 폴더 없음). down 적용이 a → a/b → a/b/c를 만들고 파일을 써야 한다.
		await b.pull();
		await b.sync("down");

		expect(b.vault.has("a/b/c/deep.md")).toBe(true);
		expect(b.vault.textOf("a/b/c/deep.md")).toBe("deep content");
		// 적용 중 오류 로그가 없어야 한다(부모 폴더 부재로 인한 create 실패 등).
		expect(b.log.filter((l) => l.level === "error")).toEqual([]);
	});

	it("깊은 바이너리 첨부도 동일하게 중간 폴더를 생성한다", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "devA2", role: "member", remoteDb: "mirror_s2" });
		const b = cluster.device({ deviceId: "devB2", role: "member", remoteDb: "mirror_s2" });

		a.vault.seedBinary("x/y/z/img.png", new Uint8Array([1, 2, 3, 4]).buffer);
		expect(await a.uploader.uploadPath("x/y/z/img.png")).toBe("uploaded");
		await a.push();

		await b.pull();
		await b.sync("down");

		expect(b.vault.has("x/y/z/img.png")).toBe(true);
		expect(b.log.filter((l) => l.level === "error")).toEqual([]);
	});
});
