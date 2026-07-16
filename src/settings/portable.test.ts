import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, CoVaultSettings } from "./types";
import { exportSettings, importSettings, PORTABLE_KEYS } from "./portable";

function settings(overrides: Partial<CoVaultSettings> = {}): CoVaultSettings {
	return {
		...DEFAULT_SETTINGS,
		deviceId: "device-source",
		lastSeqByDb: { db: "99" },
		members: [],
		sharedSpaces: [],
		groups: [],
		...overrides,
	};
}

describe("portable settings", () => {
	it("사용자 구성 전체를 한 목록으로 왕복하고 device/role/user id는 현재 기기 값을 보존", () => {
		const source = settings({
			setupComplete: true,
			role: "manager",
			userId: "manager",
			managerOnboardingDone: true,
			workspaceId: "class-a",
			groups: [{ id: "g1", name: "Group", memberIds: ["m1"] }],
			groupAutoApprove: true,
			groupMaxPerMember: 7,
			managerSyncTransport: "db-updates",
			assignments: [{ _id: "assignment:a1", type: "assignment", schemaVersion: 1, workspaceId: "class-a", uid: "a1", title: "A", instructions: "I", templatePaths: [], privacy: "mirror", targetMembers: ["m1"], createdBy: "manager", createdAtMs: 1 }],
			noticeTemplate: "Templates/notice.md",
			lessonTemplate: "Templates/lesson.md",
			assignmentTemplate: "Templates/assignment.md",
			rtServiceUsername: "covault-rt",
			panelTabs: ["dashboard", "sync"],
			rememberLastTab: true,
			dashboardPageSize: 25,
			dashboardOrder: ["assignments", "notices"],
			classroomModules: { routines: false, gradebook: true },
		});
		const current = settings({
			setupComplete: true,
			role: "member",
			userId: "local-user",
			deviceId: "device-current",
			lastSeqByDb: { keep: "7" },
		});
		const result = importSettings(current, exportSettings(source));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const key of PORTABLE_KEYS) expect(result.settings[key]).toEqual(source[key]);
		expect(result.settings.role).toBe("member");
		expect(result.settings.userId).toBe("local-user");
		expect(result.settings.deviceId).toBe("device-current");
		expect(result.settings.lastSeqByDb).toEqual({ keep: "7" });
	});

	it("자격증명·marker·최근 기기 상태를 내보내지 않고 가져올 때 배포 상태를 초기화", () => {
		const source = settings({
			password: "admin-secret",
			passwordSet: true,
			yjsSecret: "hmac-secret",
			yjsSecretSet: true,
			rtServicePasswordSet: true,
			lastActiveTab: "chat",
			lastChatChannel: "dm:m1",
			handledPluginDeploys: { evil: "hash" },
			members: [{
				memberId: "m1", memberName: "M", remoteDb: "mirror_m1", localRoot: "M", username: "m1",
				password: "member-secret", provisioned: true, realtimeToken: "member-token", realtimeTokenSet: true,
				managerMirrorToken: "manager-token", managerMirrorTokenSet: true,
				deviceAccounts: [{ username: "m1-d1", createdAt: 1 }],
			}],
			sharedSpaces: [{ id: "s1", name: "S", remoteDb: "share_s1", folder: "S", members: ["m1"], provisioned: true, token: "space-token", tokenSet: true, lastDeployedAt: 1, lastMemberSnapshot: ["m1"] }],
		});
		const json = exportSettings(source);
		expect(json).not.toContain("admin-secret");
		expect(json).not.toContain("member-secret");
		expect(json).not.toContain("member-token");
		expect(json).not.toContain("manager-token");
		expect(json).not.toContain("space-token");
		expect(json).not.toContain("handledPluginDeploys");

		const result = importSettings(settings({ password: "old", passwordSet: true, yjsSecret: "old-yjs", yjsSecretSet: true }), json);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect({ password: result.settings.password, passwordSet: result.settings.passwordSet, yjsSecret: result.settings.yjsSecret, yjsSecretSet: result.settings.yjsSecretSet, rt: result.settings.rtServicePasswordSet }).toEqual({ password: "", passwordSet: false, yjsSecret: undefined, yjsSecretSet: false, rt: false });
		expect(result.settings.members[0]).toMatchObject({ provisioned: false, realtimeTokenSet: false, managerMirrorTokenSet: false, deviceAccounts: [{ username: "m1-d1", createdAt: 1 }] });
		expect(result.settings.sharedSpaces[0]).toMatchObject({ provisioned: false, tokenSet: false });
		expect(result.settings.sharedSpaces[0].lastDeployedAt).toBeUndefined();
	});

	it("배열 필드 타입이 손상된 백업을 거부", () => {
		const broken = JSON.stringify({ _meta: { app: "covault", version: 2, exportedAt: "x" }, settings: { members: "not-an-array" } });
		expect(importSettings(settings(), broken).ok).toBe(false);
	});
});
