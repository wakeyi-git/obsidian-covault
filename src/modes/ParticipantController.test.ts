import { describe, it, expect } from "vitest";
import { ParticipantController, ParticipantDeps } from "./ParticipantController";
import { DEFAULT_SETTINGS, CoVaultSettings } from "../settings/types";
import { RtPartDoc, rtPartId, RtRequestDoc, rtRequestId } from "../core/model/types";

/**
 * mirror(1:1) 실시간 옵트인 게이팅 + 토글 + 자동 만료. 공유 폴더 동작은 종전대로 유지되는지 함께 고정.
 * rtpart 저장소·realtime()을 가짜로 주입해 순수하게 게이팅 로직만 검증한다.
 */

interface Fake {
	ctl: ParticipantController;
	puts: RtPartDoc[];
	store: Map<string, RtPartDoc>;
}

function make(opts: {
	role: "manager" | "member";
	userId?: string;
	mirror: boolean;
	rtpart?: string[] | null; // 옵트인 명단(null/undefined=문서 없음)
	sharedReadOnly?: boolean;
}): Fake {
	const s: CoVaultSettings = {
		...DEFAULT_SETTINGS,
		role: opts.role,
		userId: opts.userId ?? "mgr",
		workspaceId: "ws",
		sharedReadOnly: !!opts.sharedReadOnly,
		members: [{ memberId: "stu", memberName: "학생", username: "stu", remoteDb: "mirror_stu", localRoot: "stu", provisioned: true } as any],
	};
	const store = new Map<string, RtPartDoc>();
	if (opts.rtpart) {
		store.set(rtPartId("note.md"), {
			_id: rtPartId("note.md"),
			type: "rtpart",
			schemaVersion: 1,
			workspaceId: "ws",
			dbPath: "note.md",
			memberIds: opts.rtpart,
			updatedAtMs: 1,
		} as RtPartDoc);
	}
	const puts: RtPartDoc[] = [];
	const sync = {
		ctx: {
			remoteDb: "mirror_stu",
			toDbPath: (_p: string) => "note.md",
			toLocalPath: (d: string) => d,
			notifyLocalWrite: () => {},
			pouch: {
				get: async <T>(id: string): Promise<T> => {
					const d = store.get(id);
					if (!d) throw new Error("not found");
					return d as unknown as T;
				},
				put: async (doc: RtPartDoc) => {
					puts.push(doc);
					store.set(doc._id, doc);
				},
				allDocsByPrefix: async () => [...store.values()],
			},
		},
	};
	const deps: ParticipantDeps = {
		app: { vault: { getAbstractFileByPath: () => ({}) } } as any,
		logger: { warn() {}, error() {}, ok() {}, info() {} } as any,
		settings: () => s,
		realtime: () =>
			({
				isMirrorPath: () => opts.mirror,
				mirrorMemberIdFor: () => (opts.mirror ? "stu" : null),
				invalidateParticipants: () => {},
			}) as any,
		getSyncs: () => [sync as any],
		findSyncOwning: () => sync as any,
		sharedSpaces: () => [],
		saveSettings: async () => {},
		refreshMemberShares: async () => {},
		writeRtControl: async () => {},
		redeployValidate: async () => {},
		requestValidateRedeploy: () => {},
	};
	return { ctl: new ParticipantController(deps), puts, store };
}

describe("canEditRealtime — mirror 1:1 옵트인 게이팅", () => {
	it("mirror 파일은 rtpart 옵트인이 없으면 거부(파일 동기화만) — 교사·학생 모두", async () => {
		expect(await make({ role: "manager", mirror: true, rtpart: null }).ctl.canEditRealtime("stu/note.md")).toBe(false);
		expect(await make({ role: "member", userId: "stu", mirror: true, rtpart: null }).ctl.canEditRealtime("stu/note.md")).toBe(false);
	});

	it("mirror 파일에 옵트인이 있으면: 교사 허용, 명단의 학생 허용, 명단 밖 학생 거부", async () => {
		expect(await make({ role: "manager", mirror: true, rtpart: ["stu"] }).ctl.canEditRealtime("stu/note.md")).toBe(true);
		expect(await make({ role: "member", userId: "stu", mirror: true, rtpart: ["stu"] }).ctl.canEditRealtime("stu/note.md")).toBe(true);
		expect(await make({ role: "member", userId: "other", mirror: true, rtpart: ["stu"] }).ctl.canEditRealtime("stu/note.md")).toBe(false);
	});

	it("공유 파일은 종전대로 — 교사 전원 허용, 옵트인 게이팅 없음", async () => {
		expect(await make({ role: "manager", mirror: false, rtpart: null }).ctl.canEditRealtime("G1/note.md")).toBe(true);
	});
});

describe("setMirrorRealtime / 자동 만료", () => {
	it("토글 ON은 해당 학생을 rtpart 참여자로 지정, OFF는 soft-delete", async () => {
		const on = make({ role: "manager", mirror: true, rtpart: null });
		expect(await on.ctl.setMirrorRealtime("stu/note.md", true)).toBe(true);
		expect(on.puts.at(-1)?.memberIds).toEqual(["stu"]);
		expect(on.puts.at(-1)?.deleted).toBeFalsy();

		const off = make({ role: "manager", mirror: true, rtpart: ["stu"] });
		await off.ctl.setMirrorRealtime("stu/note.md", false);
		expect(off.puts.at(-1)?.deleted).toBe(true);
	});

	it("교사가 아니면 토글 무동작", async () => {
		const m = make({ role: "member", userId: "stu", mirror: true, rtpart: null });
		expect(await m.ctl.setMirrorRealtime("stu/note.md", true)).toBe(false);
		expect(m.puts.length).toBe(0);
	});

	it("자동 만료: 교사면 활성 옵트인을 해제, 학생이면 무동작", async () => {
		const mgr = make({ role: "manager", mirror: true, rtpart: ["stu"] });
		await mgr.ctl.onMirrorSessionClosedAlone("stu/note.md");
		expect(mgr.puts.at(-1)?.deleted).toBe(true);

		const stu = make({ role: "member", userId: "stu", mirror: true, rtpart: ["stu"] });
		await stu.ctl.onMirrorSessionClosedAlone("stu/note.md");
		expect(stu.puts.length).toBe(0);
	});
});

/** 학생 요청(rtrequest) → 교사 자동 승인(rtpart 변환). 접두사 필터 + rtrequest 시드를 지원하는 별도 fake. */
function makeReq(role: "manager" | "member", userId: string, seed?: { rtrequests?: Array<{ dbPath: string; byUser: string }>; rtpart?: string[] }) {
	const s: CoVaultSettings = {
		...DEFAULT_SETTINGS,
		role,
		userId,
		username: userId,
		workspaceId: "ws",
		members: [{ memberId: "stu", memberName: "학생", username: "stu", remoteDb: "mirror_stu", localRoot: "stu", provisioned: true } as any],
	};
	const store = new Map<string, any>();
	for (const r of seed?.rtrequests ?? []) {
		store.set(rtRequestId(r.dbPath), { _id: rtRequestId(r.dbPath), type: "rtrequest", schemaVersion: 1, workspaceId: "ws", dbPath: r.dbPath, byUser: r.byUser, byUsername: r.byUser, createdAtMs: 1 } as RtRequestDoc);
	}
	if (seed?.rtpart) store.set(rtPartId("note.md"), { _id: rtPartId("note.md"), type: "rtpart", schemaVersion: 1, workspaceId: "ws", dbPath: "note.md", memberIds: seed.rtpart, updatedAtMs: 1 } as RtPartDoc);
	const puts: any[] = [];
	const sync = {
		ctx: {
			remoteDb: "mirror_stu",
			toDbPath: () => "note.md",
			toLocalPath: (d: string) => d,
			notifyLocalWrite: () => {},
			pouch: {
				get: async <T>(id: string): Promise<T> => {
					const d = store.get(id);
					if (!d) throw new Error("not found");
					return d as T;
				},
				put: async (doc: any) => {
					puts.push(doc);
					store.set(doc._id, doc);
				},
				allDocsByPrefix: async <T>(prefix: string): Promise<T[]> => [...store.values()].filter((d) => d._id.startsWith(prefix)) as T[],
			},
		},
	};
	const deps: ParticipantDeps = {
		app: { vault: { getAbstractFileByPath: () => ({}) } } as any,
		logger: { warn() {}, error() {}, ok() {}, info() {} } as any,
		settings: () => s,
		realtime: () => ({ isMirrorPath: () => true, mirrorMemberIdFor: () => "stu", invalidateParticipants: () => {} }) as any,
		getSyncs: () => [sync as any],
		findSyncOwning: () => sync as any,
		sharedSpaces: () => [],
		saveSettings: async () => {},
		refreshMemberShares: async () => {},
		writeRtControl: async () => {},
		redeployValidate: async () => {},
		requestValidateRedeploy: () => {},
	};
	return { ctl: new ParticipantController(deps), puts, store };
}

describe("학생 요청(rtrequest) → 교사 자동 승인", () => {
	it("requestMirrorRealtime: 학생 ON은 rtrequest 기록, OFF는 soft-delete; 교사는 무동작", async () => {
		const on = makeReq("member", "stu");
		expect(await on.ctl.requestMirrorRealtime("note.md", true)).toBe(true);
		expect(on.puts.at(-1)).toMatchObject({ type: "rtrequest", byUser: "stu", byUsername: "stu" });
		expect(on.puts.at(-1)?.deleted).toBeFalsy();

		const off = makeReq("member", "stu", { rtrequests: [{ dbPath: "note.md", byUser: "stu" }] });
		await off.ctl.requestMirrorRealtime("note.md", false);
		expect(off.puts.at(-1)?.deleted).toBe(true);

		const mgr = makeReq("manager", "mgr");
		expect(await mgr.ctl.requestMirrorRealtime("note.md", true)).toBe(false);
	});

	it("listMyMirrorRequests: 내 대기 요청만 반환", async () => {
		const m = makeReq("member", "stu", { rtrequests: [{ dbPath: "note.md", byUser: "stu" }] });
		expect(await m.ctl.listMyMirrorRequests()).toEqual(["note.md"]);
		const other = makeReq("member", "other", { rtrequests: [{ dbPath: "note.md", byUser: "stu" }] });
		expect(await other.ctl.listMyMirrorRequests()).toEqual([]);
	});

	it("processMirrorRequests(교사): 요청을 rtpart 참여자로 승인하고 요청을 정리", async () => {
		const mgr = makeReq("manager", "mgr", { rtrequests: [{ dbPath: "note.md", byUser: "stu" }] });
		await mgr.ctl.processMirrorRequests();
		const rtpart = mgr.puts.find((p) => p.type === "rtpart");
		expect(rtpart?.memberIds).toEqual(["stu"]);
		const reqDel = mgr.puts.find((p) => p.type === "rtrequest");
		expect(reqDel?.deleted).toBe(true);
	});

	it("processMirrorRequests: 학생이면 무동작", async () => {
		const stu = makeReq("member", "stu", { rtrequests: [{ dbPath: "note.md", byUser: "stu" }] });
		await stu.ctl.processMirrorRequests();
		expect(stu.puts.length).toBe(0);
	});
});
