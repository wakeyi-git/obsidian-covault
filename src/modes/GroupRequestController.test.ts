// 구성원 자율 그룹: 신청-승인 컨트롤러 단위 테스트(가짜 classroom store + deployShared 모킹).
import { describe, it, expect, vi } from "vitest";
import { GroupRequestController, GroupRequestDeps } from "./GroupRequestController";
import { DEFAULT_SETTINGS, CoVaultSettings, SharedSpace, GroupConfig, MemberConfig } from "../settings/types";
import { GroupRequestDoc, groupRequestId, ROSTER_DOC_ID } from "../core/model/types";

function fakeClassroom() {
	const docs = new Map<string, any>();
	return {
		docs,
		put: async (doc: any) => {
			docs.set(doc._id, { ...doc });
			return true;
		},
		get: async (id: string) => docs.get(id) ?? null,
		listByPrefix: async (prefix: string) => [...docs.values()].filter((d) => d._id.startsWith(prefix)),
	} as any;
}

function fakeLogger() {
	const warns: string[] = [];
	return { warns, info: () => {}, ok: () => {}, warn: (m: string) => warns.push(m), error: () => {} } as any;
}

function member(id: string): MemberConfig {
	return { memberId: id, memberName: `이름${id}`, remoteDb: `mirror_${id}`, localRoot: id, username: id };
}

function makeCtl(over: Partial<CoVaultSettings> = {}, deployOk = true) {
	const settings: CoVaultSettings = {
		...DEFAULT_SETTINGS,
		role: "manager",
		userId: "teacher",
		username: "teacher",
		members: [member("a"), member("b")],
		sharedSpaces: [],
		groups: [],
		...over,
	};
	const classroom = fakeClassroom();
	const logger = fakeLogger();
	const savedGroups: GroupConfig[] = [];
	const deployShared = vi.fn(async (space: SharedSpace) => {
		if (deployOk) space.provisioned = true;
	});
	const deps: GroupRequestDeps = {
		logger,
		classroom,
		settings: () => settings,
		homeroomReady: () => true,
		saveSettings: async () => {},
		deployShared,
		// saveGroup이 컨트롤러 내부로 들어오면서(M-12) 그룹 생성 추적은 syncGroupDoc로 옮긴다
		// (saveGroup 성공 시 항상 호출되는 후속 단계 — 단언 의미 동일).
		syncGroupDoc: async (g) => {
			savedGroups.push(g);
		},
		deleteGroupDoc: async () => {},
		groupChannelFor: () => null,
		openChat: async () => {},
		deleteSharedServer: async () => {},
		refreshMemberShares: async () => {},
		restartMode: async () => {},
	};
	return { ctl: new GroupRequestController(deps), settings, classroom, logger, savedGroups, deployShared };
}

/** 구성원 시점 신청 헬퍼 — userId/username을 구성원으로 바꾼 컨트롤러로 신청 문서를 만든다. */
async function seedRequest(classroom: any, over: Partial<GroupRequestDoc> = {}): Promise<GroupRequestDoc> {
	const req: GroupRequestDoc = {
		_id: groupRequestId(over.requestId ?? "r1"),
		type: "grouprequest",
		schemaVersion: 1,
		workspaceId: "ws",
		requestId: "r1",
		name: "모둠",
		folder: "모둠",
		memberIds: ["a", "b"],
		memberNames: { a: "이름a", b: "이름b" },
		byUser: "a",
		byUsername: "a",
		status: "pending",
		createdAtMs: Date.now(),
		...over,
	};
	await classroom.put(req);
	return req;
}

describe("GroupRequestController — 구성원 신청", () => {
	it("신청은 본인을 항상 포함하고 roster 이름을 담는다", async () => {
		const { ctl, classroom } = makeCtl({ role: "member", userId: "a", username: "a", displayName: "이름a", members: [] });
		await classroom.put({ _id: ROSTER_DOC_ID, type: "roster", members: [{ memberId: "b", name: "이름b" }] });

		expect(await ctl.requestGroup({ name: "모둠", folder: "모둠", memberIds: ["b"] })).toBe(true);

		const mine = await ctl.listMyRequests();
		expect(mine).toHaveLength(1);
		expect(mine[0].memberIds).toContain("a");
		expect(mine[0].memberIds).toContain("b");
		expect(mine[0].memberNames).toMatchObject({ a: "이름a", b: "이름b" });
		expect(mine[0].status).toBe("pending");
		expect(mine[0].byUsername).toBe("a");
	});

	it("잘못된 폴더(상위 탈출)는 거부", async () => {
		const { ctl } = makeCtl({ role: "member", userId: "a", username: "a" });
		expect(await ctl.requestGroup({ name: "g", folder: "../밖", memberIds: [] })).toBe(false);
	});

	it("대기 신청 상한을 넘으면 거부", async () => {
		const { ctl } = makeCtl({ role: "member", userId: "a", username: "a", groupMaxPerMember: 1 });
		expect(await ctl.requestGroup({ name: "g1", folder: "g1", memberIds: [] })).toBe(true);
		expect(await ctl.requestGroup({ name: "g2", folder: "g2", memberIds: [] })).toBe(false);
	});

	it("본인 pending 신청만 취소할 수 있다", async () => {
		const { ctl, classroom } = makeCtl({ role: "member", userId: "a", username: "a" });
		const req = await seedRequest(classroom);
		await ctl.cancelRequest(req);
		expect((await classroom.get(req._id)).deleted).toBe(true);

		const other = await seedRequest(classroom, { requestId: "r2", byUser: "b", byUsername: "b" });
		await ctl.cancelRequest(other);
		expect((await classroom.get(other._id)).deleted).toBeUndefined();
	});
});

describe("GroupRequestController — 교사 승인/거절", () => {
	it("승인: 그룹 공간 배포 + 그룹 생성 + approved 기록", async () => {
		const { ctl, settings, classroom, savedGroups, deployShared } = makeCtl();
		const req = await seedRequest(classroom);

		expect(await ctl.approveRequest(req)).toBe(true);

		expect(deployShared).toHaveBeenCalledOnce();
		const space = settings.sharedSpaces.find((sp) => sp.id === "grp_r1");
		expect(space).toMatchObject({ kind: "group", remoteDb: "share_grp_r1", folder: "모둠", members: ["a", "b"] });
		expect(savedGroups[0]).toMatchObject({ id: "r1", name: "모둠", memberIds: ["a", "b"], spaceId: "grp_r1", requestedBy: "a" });
		const updated = await classroom.get(req._id);
		expect(updated.status).toBe("approved");
		expect(updated.spaceId).toBe("grp_r1");
	});

	it("승인: 폴더가 기존 공간·구성원 폴더와 겹치면 접미로 보정", async () => {
		const { ctl, settings, classroom } = makeCtl({
			sharedSpaces: [{ id: "x", name: "x", remoteDb: "share_x", folder: "모둠", members: [] }],
		});
		const req = await seedRequest(classroom);
		await ctl.approveRequest(req);
		expect(settings.sharedSpaces.find((sp) => sp.id === "grp_r1")?.folder).toBe("모둠-2");
	});

	it("승인: 명단에 없는 memberId는 걸러진다", async () => {
		const { ctl, settings, classroom } = makeCtl();
		const req = await seedRequest(classroom, { memberIds: ["a", "ghost"] });
		await ctl.approveRequest(req);
		expect(settings.sharedSpaces.find((sp) => sp.id === "grp_r1")?.members).toEqual(["a"]);
	});

	it("승인: 배포 실패면 공간을 되돌리고 신청은 pending 유지", async () => {
		const { ctl, settings, classroom, savedGroups } = makeCtl({}, false);
		const req = await seedRequest(classroom);

		expect(await ctl.approveRequest(req)).toBe(false);

		expect(settings.sharedSpaces).toHaveLength(0);
		expect(savedGroups).toHaveLength(0);
		expect((await classroom.get(req._id)).status).toBe("pending");
	});

	it("거절: rejected + 사유 기록", async () => {
		const { ctl, classroom } = makeCtl();
		const req = await seedRequest(classroom);
		await ctl.rejectRequest(req, "사유");
		const updated = await classroom.get(req._id);
		expect(updated.status).toBe("rejected");
		expect(updated.reason).toBe("사유");
	});

	it("processPending: 자동 승인 켜면 순서대로 승인, 끄면 대기 유지", async () => {
		const auto = makeCtl({ groupAutoApprove: true });
		await seedRequest(auto.classroom);
		await seedRequest(auto.classroom, { requestId: "r2", _id: groupRequestId("r2") });
		await auto.ctl.processPending();
		expect(await auto.ctl.listPendingRequests()).toHaveLength(0);
		expect(auto.settings.sharedSpaces).toHaveLength(2);

		const manual = makeCtl({ groupAutoApprove: false });
		await seedRequest(manual.classroom);
		await manual.ctl.processPending();
		expect(await manual.ctl.listPendingRequests()).toHaveLength(1);
	});
});

describe("GroupRequestController — roster", () => {
	it("syncRoster는 명단을 기록하고 변화 없으면 다시 쓰지 않는다", async () => {
		const { ctl, classroom } = makeCtl();
		await ctl.syncRoster();
		const first = await classroom.get(ROSTER_DOC_ID);
		expect(first.members).toEqual([
			{ memberId: "a", name: "이름a" },
			{ memberId: "b", name: "이름b" },
		]);
		const putSpy = vi.spyOn(classroom, "put");
		await ctl.syncRoster();
		expect(putSpy).not.toHaveBeenCalled();
	});
});
