// 충돌 일괄 해소(RecoveryController.resolveAllConflicts): 첨부 'both-remote' 강등 · 한 건 실패 격리 · 집계.
import { describe, it, expect } from "vitest";
import { RecoveryController } from "../../src/modes/RecoveryController";
import type { ConflictRow } from "../../src/ui/ConflictModal";
import type { ConflictInfo, ResolveChoice } from "../../src/core/sync/ConflictManager";

function makeRow(dbPath: string, kind: "note" | "asset", sink: Array<[string, ResolveChoice]>, fail = false): ConflictRow {
	const info = { dbPath, kind } as unknown as ConflictInfo;
	const sync = {
		async resolveConflict(p: string, c: ResolveChoice): Promise<void> {
			if (fail) throw new Error("boom");
			sink.push([p, c]);
		},
	};
	return { sync, info } as unknown as ConflictRow;
}

function ctl(): RecoveryController {
	return new RecoveryController({
		app: {} as never,
		logger: { error() {} } as never,
		getSyncs: () => [],
		findSyncByDb: () => undefined,
		findSyncOwning: () => undefined,
		openLog: async () => {},
	});
}

describe("충돌 일괄 해소", () => {
	it("모든 행을 같은 선택지로 처리하고 성공 건수를 집계한다", async () => {
		const calls: Array<[string, ResolveChoice]> = [];
		const rows = [makeRow("a.md", "note", calls), makeRow("b.md", "note", calls)];
		const res = await ctl().resolveAllConflicts(rows, "remote");
		expect(res).toEqual({ resolved: 2, failed: 0 });
		expect(calls).toEqual([
			["a.md", "remote"],
			["b.md", "remote"],
		]);
	});

	it("첨부에는 'both-remote'를 'both'로 강등한다(노트는 그대로)", async () => {
		const calls: Array<[string, ResolveChoice]> = [];
		const rows = [makeRow("note.md", "note", calls), makeRow("img.png", "asset", calls)];
		await ctl().resolveAllConflicts(rows, "both-remote");
		expect(calls).toEqual([
			["note.md", "both-remote"],
			["img.png", "both"],
		]);
	});

	it("한 건이 실패해도 나머지를 계속 처리하고 실패 건수를 센다", async () => {
		const calls: Array<[string, ResolveChoice]> = [];
		const rows = [makeRow("ok1.md", "note", calls), makeRow("bad.md", "note", calls, true), makeRow("ok2.md", "note", calls)];
		const res = await ctl().resolveAllConflicts(rows, "local");
		expect(res).toEqual({ resolved: 2, failed: 1 });
		expect(calls.map((c) => c[0])).toEqual(["ok1.md", "ok2.md"]);
	});
});
