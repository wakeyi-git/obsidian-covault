import { describe, it, expect } from "vitest";
import { computeSyncSummary } from "./syncSummary";
import { DashboardRow } from "./PanelSection";
import { CoVaultSettings } from "../../settings/types";

function settings(over: Partial<CoVaultSettings> = {}): CoVaultSettings {
	return {
		role: "manager",
		autoSync: true,
		realtimeEnabled: false,
		yjsServerUrl: "",
		yjsToken: "",
		members: [],
		sharedSpaces: [],
		...over,
	} as CoVaultSettings;
}

function row(over: Partial<DashboardRow> = {}): DashboardRow {
	return {
		memberName: "A",
		memberId: "a",
		remoteDb: "mirror_a",
		localRoot: "A",
		conflicts: 0,
		state: "idle",
		lastUploadAt: 0,
		lastDownloadAt: 0,
		...over,
	} as DashboardRow;
}

describe("computeSyncSummary", () => {
	it("학생 없으면 empty", () => {
		expect(computeSyncSummary([], settings()).overall).toBe("empty");
	});

	it("초대 안 된 학생 수를 센다", () => {
		const s = settings({
			members: [
				{ memberId: "a", provisioned: true },
				{ memberId: "b", provisioned: false },
				{ memberId: "c" },
			] as any,
		});
		const sum = computeSyncSummary([], s);
		expect(sum.members).toBe(3);
		expect(sum.invited).toBe(1);
		expect(sum.notInvited).toBe(2);
	});

	it("충돌/오류는 attention, 오프라인은 offline, 정상은 ok", () => {
		const s = settings({ members: [{ memberId: "a", provisioned: true }] as any });
		expect(computeSyncSummary([row({ conflicts: 2 })], s).overall).toBe("attention");
		expect(computeSyncSummary([row({ state: "error" })], s).overall).toBe("attention");
		expect(computeSyncSummary([row({ state: "offline" })], s).overall).toBe("offline");
		expect(computeSyncSummary([row({ state: "idle" })], s).overall).toBe("ok");
	});

	it("자동 동기화 꺼짐이면 autosync-off(문제 없을 때)", () => {
		const s = settings({ autoSync: false, members: [{ memberId: "a", provisioned: true }] as any });
		expect(computeSyncSummary([row()], s).overall).toBe("autosync-off");
	});

	it("실시간 토큰 누락 감지(HMAC 공간 토큰 없음 + 전역 토큰 없음)", () => {
		const s = settings({
			realtimeEnabled: true,
			yjsServerUrl: "wss://x",
			yjsToken: "",
			members: [{ memberId: "a", provisioned: true }] as any,
			sharedSpaces: [{ id: "s1", token: undefined } as any],
		});
		expect(computeSyncSummary([row()], s).realtimeTokenMissing).toBe(true);
	});

	it("전역 토큰이 있으면 실시간 토큰 누락 아님", () => {
		const s = settings({
			realtimeEnabled: true,
			yjsServerUrl: "wss://x",
			yjsToken: "legacy",
			members: [{ memberId: "a", provisioned: true }] as any,
			sharedSpaces: [{ id: "s1" } as any],
		});
		expect(computeSyncSummary([row()], s).realtimeTokenMissing).toBe(false);
	});

	it("마지막 동기화 시각은 업/다운로드 최대", () => {
		const s = settings({ members: [{ memberId: "a", provisioned: true }] as any });
		const sum = computeSyncSummary([row({ lastUploadAt: 100, lastDownloadAt: 250 })], s);
		expect(sum.lastSyncAt).toBe(250);
	});
});
