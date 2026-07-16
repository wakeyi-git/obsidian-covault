import { describe, it, expect } from "vitest";
import {
	getSecretValue,
	setSecretValue,
	hasSecretStorage,
	getMemberPassword,
	setMemberPassword,
	memberPasswordId,
	spaceTokenId,
	memberMirrorTokenId,
	managerMirrorTokenId,
	COUCH_PASSWORD_ID,
	YJS_SECRET_ID,
	RT_SERVICE_PASSWORD_ID,
	persistYjsSecret,
	persistRtServicePassword,
	clearSettingsSecrets,
	persistCouchPassword,
} from "./secret";

/** Obsidian setSecret이 허용하는 id 형식: 소문자 영숫자 + 하이픈(그 외엔 throw). */
const VALID_KEY = /^[a-z0-9-]+$/;

// app.secretStorage만 접근하므로 최소 fake로 충분(App 타입은 런타임에 erase됨).
// 실제 Obsidian처럼 잘못된 id(대문자·_ 등)면 setSecret/getSecret이 throw하도록 강제 — 키 형식 회귀를 잡는다.
function fakeApp() {
	const m = new Map<string, string>();
	const assertId = (id: string) => {
		if (!VALID_KEY.test(id)) throw new Error(`invalid secret id: ${id}`);
	};
	return {
		secretStorage: {
			getSecret: (id: string) => (assertId(id), m.get(id) ?? null),
			setSecret: (id: string, v: string) => (assertId(id), void m.set(id, v)),
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

	it("모든 키 빌더는 Obsidian 허용 형식(소문자 영숫자+하이픈)을 만든다(회귀: 평문 폴백 버그)", () => {
		// 고정 키
		for (const id of [COUCH_PASSWORD_ID, YJS_SECRET_ID, RT_SERVICE_PASSWORD_ID]) {
			expect(id).toMatch(VALID_KEY);
		}
		// 까다로운 입력(대문자·_·유니코드·기호)에서도 키가 유효해야 한다 — base64url이면 대문자·_로 깨졌다.
		for (const raw of ["member_A", "share-Gmq3HZ", "학생1", "a/b+c", "MixedCase_ID"]) {
			expect(memberPasswordId(raw)).toMatch(VALID_KEY);
			expect(spaceTokenId(raw)).toMatch(VALID_KEY);
			expect(memberMirrorTokenId(raw)).toMatch(VALID_KEY);
			expect(managerMirrorTokenId(raw)).toMatch(VALID_KEY);
		}
	});

	it("대문자·기호가 섞인 id도 Secret Storage에 저장된다(회귀: setSecret throw → 평문 폴백)", () => {
		const app = fakeApp();
		// 이전엔 base64url 키(대문자·_)가 setSecret에서 throw → setSecretValue가 false → 평문 폴백.
		expect(setSecretValue(app, spaceTokenId("Gmq3HZ2u1"), "tok")).toBe(true);
		expect(getSecretValue(app, spaceTokenId("Gmq3HZ2u1"), "")).toBe("tok");
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

	it("Yjs 시크릿은 Secret Storage 성공 시 평문 제거, 실패 시 입력을 평문 fallback으로 보존", () => {
		const secure = { yjsSecret: "old", yjsSecretSet: false };
		expect(persistYjsSecret(fakeApp(), secure, "new-secret")).toBe(true);
		expect(secure).toEqual({ yjsSecret: undefined, yjsSecretSet: true });

		const fallback = { yjsSecret: undefined as string | undefined, yjsSecretSet: true };
		expect(persistYjsSecret({} as any, fallback, "keep-me")).toBe(false);
		expect(fallback).toEqual({ yjsSecret: "keep-me", yjsSecretSet: false });
	});

	it("CouchDB 비밀번호 marker도 실제 저장 성공/값 존재 여부와 일치", () => {
		const secure = { password: "old", passwordSet: false };
		persistCouchPassword(fakeApp(), secure, "pw");
		expect(secure).toEqual({ password: "", passwordSet: true });
		const fallback = { password: "old", passwordSet: true };
		persistCouchPassword({} as any, fallback, "plain");
		expect(fallback).toEqual({ password: "plain", passwordSet: false });
	});

	it("서비스 계정 비밀번호 저장 실패 시 저장됨 marker를 세우지 않는다", () => {
		const secure = { rtServicePasswordSet: false };
		expect(persistRtServicePassword(fakeApp(), secure, "pw")).toBe(true);
		expect(secure.rtServicePasswordSet).toBe(true);
		const failed = { rtServicePasswordSet: true };
		expect(persistRtServicePassword({} as any, failed, "pw")).toBe(false);
		expect(failed.rtServicePasswordSet).toBe(false);
	});

	it("설정 가져오기용 clear는 고정·구성원·공간 secret을 모두 비운다", () => {
		const app = fakeApp();
		for (const id of [
			COUCH_PASSWORD_ID,
			YJS_SECRET_ID,
			RT_SERVICE_PASSWORD_ID,
			memberPasswordId("m1"),
			memberMirrorTokenId("m1"),
			managerMirrorTokenId("m1"),
			spaceTokenId("s1"),
		]) {
			setSecretValue(app, id, "secret");
		}
		clearSettingsSecrets(app, { members: [{ memberId: "m1" }], sharedSpaces: [{ id: "s1" }] });
		expect(app.secretStorage.listSecrets().every((id: string) => app.secretStorage.getSecret(id) === "")).toBe(true);
	});
});
