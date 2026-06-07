import { describe, it, expect } from "vitest";
import { RealtimeController } from "./RealtimeController";
import { DEFAULT_SETTINGS, CoVaultSettings, MemberConfig } from "../settings/types";

function settings(over: Partial<CoVaultSettings> = {}): CoVaultSettings {
	return {
		...DEFAULT_SETTINGS,
		workspaceId: "ws",
		realtimeEnabled: true,
		yjsSecret: "sekret", // app에 secretStorage 없음 → 평문 폴백으로 이 값을 시크릿으로 사용
		sharedSpaces: [{ id: "s1", name: "S1", remoteDb: "share_s1", folder: "S1", members: ["a"] }],
		members: [{ memberId: "a", memberName: "A", username: "a", remoteDb: "mirror_a", localRoot: "a", provisioned: true } as MemberConfig],
		...over,
	};
}

function ctl(s: CoVaultSettings): RealtimeController {
	return new RealtimeController({
		app: {} as any, // secretStorage 미지원 → getSecretValue가 s.yjsSecret 폴백
		settings: () => s,
		realtime: () => ({}) as any,
		openLog: async () => {},
	});
}

describe("RealtimeController 토큰 발급/회수", () => {
	it("실시간 ON + 시크릿 있으면 공간·개인 mirror 토큰을 발급", async () => {
		const s = settings();
		await ctl(s).mintAll();
		expect(typeof s.sharedSpaces[0].token).toBe("string");
		expect(s.sharedSpaces[0].token!.length).toBeGreaterThan(0);
		expect(typeof s.members[0].realtimeToken).toBe("string");
	});

	it("실시간 OFF면 모든 토큰을 비운다(stale 재배포 방지)", async () => {
		const s = settings({ realtimeEnabled: false });
		s.sharedSpaces[0].token = "old";
		s.members[0].realtimeToken = "old";
		await ctl(s).mintAll();
		expect(s.sharedSpaces[0].token).toBeUndefined();
		expect(s.members[0].realtimeToken).toBeUndefined();
	});

	it("시크릿이 없으면(ON이어도) 토큰을 발급하지 않는다", async () => {
		const s = settings({ yjsSecret: "" });
		await ctl(s).mintAll();
		expect(s.sharedSpaces[0].token).toBeUndefined();
		expect(s.members[0].realtimeToken).toBeUndefined();
	});

	it("mintMirror: memberId 없으면 발급하지 않음", async () => {
		const s = settings();
		const m = { memberId: "", remoteDb: "mirror_x" } as MemberConfig;
		await ctl(s).mintMirror(m);
		expect(m.realtimeToken).toBeUndefined();
	});

	it("TTL 설정 시 같은 시크릿이라도 토큰이 발급된다(만료 payload 포함)", async () => {
		const s = settings({ yjsTokenTtlDays: 30 });
		await ctl(s).mintAll();
		// 토큰은 payload.sig 형식(점 포함) — 비어있지 않은 서명 토큰.
		expect(s.members[0].realtimeToken).toContain(".");
	});
});
