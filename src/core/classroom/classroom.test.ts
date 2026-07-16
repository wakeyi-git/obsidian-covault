import { describe, it, expect } from "vitest";
import { findHomeroom, setHomeroom } from "./homeroom";
import { ClassroomStore } from "./ClassroomStore";
import { SharedSpace } from "../../settings/types";
import { PouchDocBase, NoticeDoc, noticeId, noticePrefix } from "../model/types";

describe("setHomeroom / findHomeroom", () => {
	const base: SharedSpace[] = [
		{ id: "g1", name: "모둠1", remoteDb: "share_g1", folder: "모둠1", members: ["a"] },
		{ id: "g2", name: "학급방", remoteDb: "share_g2", folder: "학급방", members: ["a", "b"] },
	];

	it("미지정이면 findHomeroom은 undefined", () => {
		expect(findHomeroom(base)).toBeUndefined();
	});

	it("한 공간을 학급 공동 공간으로 지정", () => {
		const next = setHomeroom(base, "g2");
		expect(findHomeroom(next)?.id).toBe("g2");
		expect(next.find((s) => s.id === "g1")?.kind).toBeUndefined();
	});

	it("다른 공간으로 바꾸면 이전 지정은 해제(하나만 유지)", () => {
		const one = setHomeroom(base, "g2");
		const two = setHomeroom(one, "g1");
		expect(findHomeroom(two)?.id).toBe("g1");
		expect(two.find((s) => s.id === "g2")?.kind).toBeUndefined();
	});

	it("null이면 전체 해제", () => {
		const cleared = setHomeroom(setHomeroom(base, "g2"), null);
		expect(findHomeroom(cleared)).toBeUndefined();
	});
});

/** 인메모리 fake pouch(PouchService가 노출하는, ClassroomStore가 쓰는 메서드만). */
function fakePouch() {
	const m = new Map<string, PouchDocBase>();
	return {
		async put<T extends PouchDocBase>(doc: T) {
			const next = { ...doc, _rev: `${(m.size + 1).toString()}` };
			m.set(doc._id, next);
			return next as T & { _rev: string };
		},
		async get<T extends PouchDocBase>(id: string) {
			return (m.get(id) as T) ?? null;
		},
		async update<T extends PouchDocBase>(id: string, mutate: (current: (T & { _rev: string }) | null) => T | null | Promise<T | null>) {
			const current = (m.get(id) as (T & { _rev: string })) ?? null;
			const doc = await mutate(current);
			if (!doc) return null;
			const next = { ...doc, _rev: `${m.size + 1}` } as T & { _rev: string };
			m.set(id, next);
			return next;
		},
		async allDocsByPrefix<T extends PouchDocBase>(prefix: string) {
			return [...m.values()].filter((d) => d._id.startsWith(prefix)) as T[];
		},
	};
}

const fakeCore = { settings: { workspaceId: "ws_x", userId: "u", role: "manager" } } as any;

describe("ClassroomStore", () => {
	it("homeroom 미준비면 ready=false, put/get/list는 빈/false", async () => {
		const store = new ClassroomStore(fakeCore, () => undefined);
		expect(store.ready()).toBe(false);
		expect(await store.put({ _id: "x" } as PouchDocBase)).toBe(false);
		expect(await store.get("x")).toBeNull();
		expect(await store.listByPrefix("notice:")).toEqual([]);
	});

	it("homeroom 준비되면 put→get→listByPrefix 라운드트립 + onChange 알림", async () => {
		const pouch = fakePouch();
		const store = new ClassroomStore(fakeCore, () => pouch as any);
		let changes = 0;
		store.onChange(() => changes++);

		const doc: NoticeDoc = {
			_id: noticeId("n1"),
			type: "notice",
			schemaVersion: 1,
			workspaceId: "ws_x",
			uid: "n1",
			title: "안내",
			filePath: "_학급/알림장/2026-06-06.md",
			postedAtMs: 1,
			createdBy: "u",
			createdByRole: "manager",
		};
		expect(await store.put(doc)).toBe(true);
		expect(changes).toBe(1);
		expect((await store.get<NoticeDoc>(noticeId("n1")))?.title).toBe("안내");
		expect(await store.listByPrefix<NoticeDoc>(noticePrefix())).toHaveLength(1);

		await store.softDelete(doc);
		expect((await store.get<NoticeDoc>(noticeId("n1")))?.deleted).toBe(true);
		expect(changes).toBe(2);
	});
});
