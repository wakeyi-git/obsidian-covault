import { describe, it, expect } from "vitest";
import { InvitePayload, encodeInvite, parseInvite, buildInviteUri, isInviteExpired } from "./invite";

const base: InvitePayload = {
	v: 1,
	couchdbUrl: "https://nas.example.com",
	workspaceId: "ws_2026_1",
	memberId: "member_a",
	memberName: "구성원A",
	remoteDb: "mirror_member_a",
	username: "member_a",
	password: "s3cretPW",
};

describe("invite encode/parse round-trip", () => {
	it("payload → 코드 → payload 동일", () => {
		const code = encodeInvite(base);
		expect(parseInvite(code)).toEqual(base);
	});

	it("obsidian:// URI에서도 파싱(d= 추출)", () => {
		const uri = buildInviteUri(base);
		expect(parseInvite(uri)).toEqual(base);
	});

	it("iat/exp가 있어도 round-trip 보존", () => {
		const withTtl: InvitePayload = { ...base, iat: 1_000_000, exp: 1_000_000 + 14 * 86400 };
		expect(parseInvite(encodeInvite(withTtl))).toEqual(withTtl);
	});

	it("잘못된 코드는 null", () => {
		expect(parseInvite("not-a-valid-code")).toBeNull();
		expect(parseInvite("")).toBeNull();
	});

	it("couchdbUrl이 http(s) URL이 아니면 거부(딥링크 주입 차단)", () => {
		expect(parseInvite(encodeInvite({ ...base, couchdbUrl: "javascript:alert(1)" }))).toBeNull();
		expect(parseInvite(encodeInvite({ ...base, couchdbUrl: "file:///etc/passwd" }))).toBeNull();
		expect(parseInvite(encodeInvite({ ...base, couchdbUrl: "not a url" }))).toBeNull();
		expect(parseInvite(encodeInvite({ ...base, couchdbUrl: "http://192.168.0.2:5984" }))).not.toBeNull();
	});
});

describe("isInviteExpired", () => {
	it("exp 없으면(구버전/무만료) 항상 false", () => {
		expect(isInviteExpired(base, 9_999_999_999)).toBe(false);
	});

	it("exp 이전이면 false, 이후면 true", () => {
		const exp = 1_000_000;
		const p: InvitePayload = { ...base, iat: exp - 86400, exp };
		expect(isInviteExpired(p, exp - 1)).toBe(false);
		expect(isInviteExpired(p, exp)).toBe(false); // 경계: 같은 초는 아직 유효
		expect(isInviteExpired(p, exp + 1)).toBe(true);
	});

	it("만료된 초대도 parseInvite 자체는 성공(차단은 호출측 책임)", () => {
		const p: InvitePayload = { ...base, iat: 1, exp: 2 };
		const parsed = parseInvite(encodeInvite(p));
		expect(parsed).not.toBeNull();
		expect(isInviteExpired(parsed!, 1_000_000)).toBe(true);
	});
});
