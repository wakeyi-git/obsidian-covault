import { describe, it, expect } from "vitest";
import {
	getSecretValue,
	setSecretValue,
	hasSecretStorage,
	getMemberPassword,
	setMemberPassword,
	memberPasswordId,
	COUCH_PASSWORD_ID,
} from "./secret";

// app.secretStorage만 접근하므로 최소 fake로 충분(App 타입은 런타임에 erase됨).
function fakeApp() {
	const m = new Map<string, string>();
	return {
		secretStorage: {
			getSecret: (id: string) => m.get(id) ?? null,
			setSecret: (id: string, v: string) => void m.set(id, v),
			listSecrets: () => [...m.keys()],
		},
	} as any;
}

describe("secret storage helpers", () => {
	it("set→get 라운드트립 + 미지원 환경 평문 폴백", () => {
		const app = fakeApp();
		expect(hasSecretStorage(app)).toBe(true);
		expect(setSecretValue(app, COUCH_PASSWORD_ID, "pw1")).toBe(true);
		expect(getSecretValue(app, COUCH_PASSWORD_ID, "")).toBe("pw1");

		const noSs = {} as any; // secretStorage 없음
		expect(hasSecretStorage(noSs)).toBe(false);
		expect(setSecretValue(noSs, COUCH_PASSWORD_ID, "x")).toBe(false);
		expect(getSecretValue(noSs, COUCH_PASSWORD_ID, "plain")).toBe("plain"); // 폴백
	});

	it("빈 secret이면 fallback 사용", () => {
		const app = fakeApp();
		expect(getSecretValue(app, COUCH_PASSWORD_ID, "fb")).toBe("fb");
	});

	it("학생별 비밀번호 키 + 라운드트립", () => {
		const app = fakeApp();
		setMemberPassword(app, "member_a", "pwA");
		setMemberPassword(app, "member_b", "pwB");
		expect(getMemberPassword(app, "member_a", "")).toBe("pwA");
		expect(getMemberPassword(app, "member_b", "")).toBe("pwB");
		// 키가 학생별로 분리됨
		expect(app.secretStorage.listSecrets()).toContain(memberPasswordId("member_a"));
	});

	it("memberPasswordId 정규화(소문자-영숫자-대시)", () => {
		expect(memberPasswordId("Member_A")).toBe("covault-member-pw-member-a");
		expect(memberPasswordId("2024-001")).toBe("covault-member-pw-2024-001");
		expect(memberPasswordId("  spaced id  ")).toBe("covault-member-pw-spaced-id");
	});
});
