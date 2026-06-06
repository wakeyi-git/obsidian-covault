import { describe, it, expect } from "vitest";
import { clearSpaceTokens } from "../core/realtime/spaceToken";
import { isValidCouchName } from "../core/path/path";
import { validateSettings } from "./validateSettings";
import { exportSettings, importSettings } from "./portable";
import { DEFAULT_SETTINGS, CoVaultSettings } from "./types";

// --- P1: 시크릿 없을 때 공간 토큰 제거 ---
describe("clearSpaceTokens (P1)", () => {
	it("기존 토큰을 모두 제거한다", () => {
		const spaces = [{ id: "g1", token: "t1" }, { id: "g2", token: "t2" }, { id: "g3" }];
		clearSpaceTokens(spaces);
		expect(spaces.every((s) => s.token === undefined)).toBe(true);
	});
});

// --- P2-b: CouchDB 이름 검증 ---
describe("isValidCouchName (P2)", () => {
	it("유효한 이름 통과", () => {
		for (const n of ["member_a", "2024001", "mirror_s1", "share_g1", "a-b_c"]) expect(isValidCouchName(n)).toBe(true);
	});
	it("규칙 위반 거부", () => {
		for (const n of ["Member", "학생", "a b", "_x", "-x", "a.b", "a/b", ""]) expect(isValidCouchName(n)).toBe(false);
	});
});

describe("validateSettings 형식 검사 (P2)", () => {
	const base = (over: Partial<CoVaultSettings>): CoVaultSettings => ({ ...DEFAULT_SETTINGS, role: "manager", ...over });
	it("잘못된 학생 ID/계정/DB를 error로 보고", () => {
		const issues = validateSettings(
			base({ members: [{ memberId: "학생A", memberName: "x", remoteDb: "Mirror_X", username: "Up", localRoot: "" }] }),
		);
		const codes = issues.map((i) => i.code);
		expect(codes).toContain("bad-memberId");
		expect(codes).toContain("bad-username");
		expect(codes).toContain("bad-remoteDb");
	});
	it("정상 설정은 형식 오류 없음", () => {
		const issues = validateSettings(
			base({ members: [{ memberId: "member_a", memberName: "x", remoteDb: "mirror_member_a", username: "member_a", localRoot: "a" }] }),
		);
		expect(issues.some((i) => i.code.startsWith("bad-"))).toBe(false);
	});
	it("빈 값은 검사 대상 아님", () => {
		const issues = validateSettings(base({ members: [{ memberId: "", memberName: "", remoteDb: "", username: "", localRoot: "" }] }));
		expect(issues.some((i) => i.code.startsWith("bad-"))).toBe(false);
	});
});

// --- P2-a: 설정 export→import round-trip ---
describe("portable round-trip (P2)", () => {
	it("새 운영 옵션이 보존되고 secret/device는 제외", () => {
		const src: CoVaultSettings = {
			...DEFAULT_SETTINGS,
			role: "manager",
			deleteReconcileMax: 7,
			versionHistory: false,
			versionMaxCount: 3,
			versionMaxAgeDays: 14,
			yjsTokenTtlDays: 30,
			inviteTtlDays: 21,
			language: "en",
			password: "secret",
			passwordSet: true,
			deviceId: "dev-123",
		};
		const json = exportSettings(src);
		// export에 secret/device 키가 없어야 한다.
		expect(json).not.toContain("secret");
		expect(json).not.toContain("dev-123");

		const target: CoVaultSettings = { ...DEFAULT_SETTINGS, role: "manager", deviceId: "other" };
		const res = importSettings(target, json);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const m = res.settings;
		expect(m.deleteReconcileMax).toBe(7);
		expect(m.versionHistory).toBe(false);
		expect(m.versionMaxCount).toBe(3);
		expect(m.versionMaxAgeDays).toBe(14);
		expect(m.yjsTokenTtlDays).toBe(30);
		expect(m.inviteTtlDays).toBe(21);
		expect(m.language).toBe("en");
		// device/secret/role은 현재 기기 보존
		expect(m.deviceId).toBe("other");
	});
});
