import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";

describe("harness smoke", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	it("uploads a note, replicates to an observer device", async () => {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "devA", role: "manager", remoteDb: "mirror_s1" });
		const observer = cluster.device({ deviceId: "devB", role: "member", remoteDb: "mirror_s1" });

		a.vault.seed("notes/hello.md", "hello world");
		const res = await a.uploader.uploadPath("notes/hello.md");
		expect(res).toBe("uploaded");

		expect((await a.note("notes/hello.md"))?.content).toBe("hello world");

		await a.push();
		await observer.pull();
		const seen = await observer.note("notes/hello.md");
		expect(seen).toBeTruthy();
		expect(seen?.deleted).toBe(false);
		expect(seen?.content).toBe("hello world");
	});
});
