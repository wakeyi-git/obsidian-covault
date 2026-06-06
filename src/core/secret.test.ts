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
		// 키가 구성원별로 분리됨
		expect(app.secretStorage.listSecrets()).toContain(memberPasswordId("member_a"));
	});

	it("키는 _/- 가 섞여도 충돌하지 않는다(회귀)", () => {
		// 서로 다른 유효 ID는 서로 다른 키여야 한다(정규화 방식이면 둘 다 member-a로 충돌).
		expect(memberPasswordId("member_a")).not.toBe(memberPasswordId("member-a"));

		const app = fakeApp();
		setMemberPassword(app, "member_a", "pw_underscore");
		setMemberPassword(app, "member-a", "pw-hyphen");
		// 서로 덮어쓰지 않는다.
		expect(getMemberPassword(app, "member_a", "")).toBe("pw_underscore");
		expect(getMemberPassword(app, "member-a", "")).toBe("pw-hyphen");
	});
});
