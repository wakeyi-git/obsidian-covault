import { describe, it, expect } from "vitest";
import { pickSyncByDb, pickSyncOwning } from "./syncLookup";
import { MirrorSync } from "./MirrorSync";

// MirrorSync 전체를 만들지 않고 remoteDb/owns만 가진 가짜로 순수 조회를 검증.
function fake(remoteDb: string, owned: string[]): MirrorSync {
	return { remoteDb, owns: (p: string) => owned.includes(p) } as unknown as MirrorSync;
}

describe("pickSyncByDb", () => {
	const syncs = [fake("mirror_a", []), fake("mirror_b", []), fake("share_x", [])];
	it("remoteDb 일치 링크를 찾는다", () => {
		expect(pickSyncByDb(syncs, "mirror_b")).toBe(syncs[1]);
	});
	it("없으면 undefined", () => {
		expect(pickSyncByDb(syncs, "nope")).toBeUndefined();
		expect(pickSyncByDb([], "mirror_a")).toBeUndefined();
	});
});

describe("pickSyncOwning", () => {
	const syncs = [fake("a", ["A/note.md"]), fake("b", ["B/x.md", "B/y.md"])];
	it("경로를 owns하는 링크를 찾는다", () => {
		expect(pickSyncOwning(syncs, "B/y.md")).toBe(syncs[1]);
	});
	it("아무도 소유하지 않으면 undefined", () => {
		expect(pickSyncOwning(syncs, "C/z.md")).toBeUndefined();
	});
});
