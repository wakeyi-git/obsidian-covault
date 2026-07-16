import { afterEach, describe, expect, it, vi } from "vitest";
import { Cluster } from "../harness/env";
import { MirrorSync } from "../../src/core/sync/MirrorSync";

describe("MirrorSync start/stop lifecycle", () => {
	let cluster: Cluster;
	let sync: MirrorSync | null = null;

	afterEach(async () => {
		await sync?.stop();
		cluster?.dispose();
	});

	it("시작 정합 도중 stop되면 뒤늦게 watcher/applier/replication을 시작하지 않는다", async () => {
		cluster = new Cluster();
		const device = cluster.device({ deviceId: "lifecycle", role: "member", remoteDb: "mirror_lifecycle" });
		sync = new MirrorSync(device.core, {
			memberId: "member_a",
			memberName: "학생A",
			localRoot: "",
			remoteDb: "mirror_lifecycle",
		});

		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const started = new Promise<void>((resolve) => (entered = resolve));
		vi.spyOn((sync as any).fullSyncRunner, "runStartup").mockImplementation(async () => {
			entered();
			await gate;
		});
		const watcherStart = vi.spyOn((sync as any).watcher, "start");
		const applierStart = vi.spyOn((sync as any).localApplier, "start");
		const replicationStart = vi.spyOn(sync.ctx.pouch, "startReplication");

		const startTask = sync.start();
		await started;
		const stopTask = sync.stop();
		release();
		await Promise.all([startTask, stopTask]);

		expect(watcherStart).not.toHaveBeenCalled();
		expect(applierStart).not.toHaveBeenCalled();
		expect(replicationStart).not.toHaveBeenCalled();
		expect(sync.status.state).toBe("disabled");
	});

	it("동시 start 호출은 같은 시작 작업을 공유한다", async () => {
		cluster = new Cluster();
		const device = cluster.device({ deviceId: "double-start", role: "member", remoteDb: "mirror_double_start" });
		sync = new MirrorSync(device.core, {
			memberId: "member_a",
			memberName: "학생A",
			localRoot: "",
			remoteDb: "mirror_double_start",
		});
		const startup = vi.spyOn((sync as any).fullSyncRunner, "runStartup").mockResolvedValue(undefined);
		const first = sync.start();
		const second = sync.start();
		await Promise.all([first, second]);
		expect(startup).toHaveBeenCalledTimes(1);
	});
});
