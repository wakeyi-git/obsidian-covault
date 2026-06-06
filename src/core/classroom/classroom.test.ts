import { describe, it, expect } from "vitest";
import { ensureHomeroomSpace, findHomeroom, HOMEROOM_ID, HOMEROOM_DB, HOMEROOM_FOLDER } from "./homeroom";
import { ClassroomStore } from "./ClassroomStore";
import { SharedSpace } from "../../settings/types";
import { PouchDocBase, NoticeDoc, noticeId, noticePrefix } from "../model/types";

describe("ensureHomeroomSpace", () => {
	it("없으면 학급 공간을 생성(전원 멤버, 고정 id/DB/폴더)", () => {
		const { space, spaces } = ensureHomeroomSpace([], ["a", "b"], "학급");
		expect(space.id).toBe(HOMEROOM_ID);
		expect(space.kind).toBe("homeroom");
		expect(space.remoteDb).toBe(HOMEROOM_DB);
		expect(space.folder).toBe(HOMEROOM_FOLDER);
		expect(space.members).toEqual(["a", "b"]);
		expect(spaces).toHaveLength(1);
	});

	it("있으면 멤버만 갱신하고 DB/폴더는 보존(이미 배포 안전)", () => {
		const existing: SharedSpace[] = [
			{ id: HOMEROOM_ID, kind: "homeroom", name: "우리반", remoteDb: HOMEROOM_DB, folder: "_학급", members: ["a"], provisioned: true },
		];
		const { space, spaces } = ensureHomeroomSpace(existing, ["a", "b", "c"], "학급");
		expect(space.members).toEqual(["a", "b", "c"]);
		expect(space.provisioned).toBe(true);
		expect(space.name).toBe("우리반");
		expect(spaces).toHaveLength(1);
	});

	it("일반 공유 공간과 섞여 있어도 학급 공간만 찾는다", () => {
		const spaces: SharedSpace[] = [
			{ id: "g1", name: "모둠1", remoteDb: "share_g1", folder: "모둠1", members: ["a"] },
			{ id: HOMEROOM_ID, kind: "homeroom", name: "학급", remoteDb: HOMEROOM_DB, folder: "_학급", members: ["a"] },
		];
		expect(findHomeroom(spaces)?.id).toBe(HOMEROOM_ID);
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
