import { describe, it, expect } from "vitest";
import { MemberController } from "./MemberController";
import { DEFAULT_SETTINGS, CoVaultSettings, MemberConfig } from "../settings/types";
import { SHARES_DOC_ID, RTCONFIG_DOC_ID, SharesDoc } from "../core/model/types";

function settings(over: Partial<CoVaultSettings> = {}): CoVaultSettings {
	return {
		...DEFAULT_SETTINGS,
		workspaceId: "ws",
		realtimeEnabled: true,
		yjsServerUrl: "wss://rt",
		realtimeSnapshotSec: 30,
		sharedSpaces: [
			{ id: "g1", name: "G1", remoteDb: "share_g1", folder: "G1", members: ["a"], token: "t1" },
			{ id: "hr", name: "HR", remoteDb: "share_hr", folder: "HR", members: ["a"], token: "t2", kind: "homeroom" },
			{ id: "g2", name: "G2", remoteDb: "share_g2", folder: "G2", members: ["b"] },
		],
		...over,
	};
}

/** putDoc 호출을 기록하는 가짜 CouchAdmin. */
function fakeAdmin() {
	const calls: Array<{ db: string; doc: any }> = [];
	return {
		calls,
		putDoc: async (db: string, doc: any) => {
			calls.push({ db, doc });
			return { ok: true };
		},
	};
}

function ctl(s: CoVaultSettings): MemberController {
	return new MemberController({
		app: {} as any,
		logger: { warn() {}, error() {}, ok() {}, info() {} } as any,
		settings: () => s,
		couchPassword: () => "pw",
		saveSettings: async () => {},
		requestApply: () => {},
		openLog: async () => {},
		mintMirror: async () => {},
		// 멤버별 토큰 발급(실제는 RealtimeController가 m/r 클레임으로 서명) — 테스트는 결정적 문자열로 대체.
		mintMemberToken: async (sp, memberId) => `member-token:${sp.id}:${memberId}`,
	});
}

describe("MemberController.writeMemberSync — shares/rtconfig 조립", () => {
	const member: MemberConfig = { memberId: "a", memberName: "A", username: "a", remoteDb: "mirror_a", localRoot: "a", provisioned: true, realtimeToken: "rt-a" } as MemberConfig;

	it("구성원이 속한 공간만 shares에 담고, kind(share/homeroom) 매핑 + 개인 mirror 항목 추가", async () => {
		const s = settings();
		const admin = fakeAdmin();
		await ctl(s).writeMemberSync(admin as any, member);

		const sharesCall = admin.calls.find((c) => c.doc._id === SHARES_DOC_ID);
		expect(sharesCall?.db).toBe("mirror_a");
		const spaces = (sharesCall!.doc as SharesDoc).spaces;
		const ids = spaces.map((x) => x.id);
		expect(ids).toContain("g1");
		expect(ids).toContain("hr");
		expect(ids).not.toContain("g2"); // a는 g2 멤버 아님
		expect(ids).toContain("mirror-a"); // 개인 mirror 실시간 항목
		expect(spaces.find((x) => x.id === "g1")!.kind).toBe("share");
		expect(spaces.find((x) => x.id === "hr")!.kind).toBe("homeroom");
		expect(spaces.find((x) => x.id === "mirror-a")!.kind).toBe("mirror");
	});

	it("공간 토큰은 교사용(sp.token)이 아닌 멤버별 발급 토큰을 내려보낸다", async () => {
		const s = settings();
		const admin = fakeAdmin();
		await ctl(s).writeMemberSync(admin as any, member);
		const spaces = (admin.calls.find((c) => c.doc._id === SHARES_DOC_ID)!.doc as SharesDoc).spaces;
		expect(spaces.find((x) => x.id === "g1")!.token).toBe("member-token:g1:a"); // sp.token("t1") 아님
		expect(spaces.find((x) => x.id === "mirror-a")!.token).toBe("rt-a"); // mirror는 member.realtimeToken 그대로
	});

	it("rtconfig는 레거시 전역 토큰을 포함하지 않는다(공간별 HMAC만)", async () => {
		const s = settings();
		const admin = fakeAdmin();
		await ctl(s).writeMemberSync(admin as any, member);
		const rc = admin.calls.find((c) => c.doc._id === RTCONFIG_DOC_ID);
		expect(rc).toBeTruthy();
		expect(rc!.doc.enabled).toBe(true);
		expect(rc!.doc.url).toBe("wss://rt");
		expect("token" in rc!.doc).toBe(false); // 전역 토큰 미배포
	});

	it("실시간 OFF면 개인 mirror 항목을 넣지 않는다", async () => {
		const s = settings({ realtimeEnabled: false });
		const admin = fakeAdmin();
		await ctl(s).writeMemberSync(admin as any, { ...member } as MemberConfig);
		const spaces = (admin.calls.find((c) => c.doc._id === SHARES_DOC_ID)!.doc as SharesDoc).spaces;
		expect(spaces.some((x) => x.id === "mirror-a")).toBe(false);
	});
});
