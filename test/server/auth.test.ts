// 서버 토큰 검증(auth.js)과 클라이언트 발급(spaceToken.ts)의 **교차** 라운드트립 — 평가 P1-1(테스트 #2).
// 기존엔 클라이언트가 자기 verifySpaceToken으로만 검증해, '한 쌍'인 서버 verifyToken과 b64url/페이로드
// 형식이 어긋나는 회귀(실시간 접속 전체가 무음으로 깨짐)를 어떤 테스트도 못 잡았다. 여기서 실제로
// 클라이언트가 만든 토큰을 서버 검증기로 통과시켜 공간 격리·만료·변조까지 검증한다.
import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyToken, parseRoom, rejectPlaceholder } from "../../server/hocuspocus/auth.js";
import { mintSpaceToken } from "../../src/core/realtime/spaceToken";

const SECRET = "test-secret-0123456789-abcdef"; // >=16자(placeholder 거부 통과)
const CLAIMS = { workspaceId: "ws1", spaceId: "g1", remoteDb: "share_g1", memberId: "m1", role: "member" as const };
const ROOM = `${CLAIMS.workspaceId}/share/${CLAIMS.spaceId}/모둠활동/토론.md`;

describe("교차 검증: 클라이언트 mintSpaceToken → 서버 verifyToken", () => {
	it("같은 시크릿으로 발급한 토큰을 서버가 받아들이고 클레임을 복원한다", async () => {
		const token = await mintSpaceToken(SECRET, CLAIMS);
		const claims = verifyToken(SECRET, ROOM, token);
		expect(claims).not.toBeNull();
		expect(claims).toMatchObject({ c: "ws1", s: "g1", d: "share_g1", m: "m1", r: "member" });
	});

	it("manager 역할·만료(exp) 클레임도 왕복된다", async () => {
		const exp = Math.floor(Date.now() / 1000) + 3600;
		const token = await mintSpaceToken(SECRET, { ...CLAIMS, role: "manager", exp });
		const claims = verifyToken(SECRET, ROOM, token);
		expect(claims?.r).toBe("manager");
		expect(claims?.e).toBe(exp);
	});

	it("다른 시크릿으로 검증하면 거부(서명 불일치)", async () => {
		const token = await mintSpaceToken(SECRET, CLAIMS);
		expect(verifyToken("another-secret-0123456789", ROOM, token)).toBeNull();
	});

	it("공간 격리: s1 토큰은 s2 room에서 거부(room prefix 불일치)", async () => {
		const token = await mintSpaceToken(SECRET, CLAIMS);
		const otherRoom = "ws1/share/g2/모둠활동/토론.md"; // 다른 spaceId
		expect(verifyToken(SECRET, otherRoom, token)).toBeNull();
	});

	it("워크스페이스 격리: 다른 workspaceId room에서 거부", async () => {
		const token = await mintSpaceToken(SECRET, CLAIMS);
		expect(verifyToken(SECRET, "ws2/share/g1/x.md", token)).toBeNull();
	});

	it("만료된 토큰은 거부", async () => {
		const past = Math.floor(Date.now() / 1000) - 10;
		const token = await mintSpaceToken(SECRET, { ...CLAIMS, exp: past });
		expect(verifyToken(SECRET, ROOM, token)).toBeNull();
	});

	it("페이로드 변조(서명 불일치) 거부", async () => {
		const token = await mintSpaceToken(SECRET, CLAIMS);
		const [, sig] = token.split(".");
		// 다른 멤버로 위조한 페이로드 + 원래 서명 → 검증 실패
		const forged = await mintSpaceToken(SECRET, { ...CLAIMS, memberId: "m2" });
		const forgedPayload = forged.split(".")[0];
		expect(verifyToken(SECRET, ROOM, `${forgedPayload}.${sig}`)).toBeNull();
	});

	it("서명 절단/형식 오류 토큰 거부", async () => {
		const token = await mintSpaceToken(SECRET, CLAIMS);
		expect(verifyToken(SECRET, ROOM, token.slice(0, -4))).toBeNull(); // 서명 일부 손상
		expect(verifyToken(SECRET, ROOM, "nodot")).toBeNull();
		expect(verifyToken(SECRET, ROOM, "")).toBeNull();
		expect(verifyToken(SECRET, ROOM, undefined as unknown as string)).toBeNull();
	});
});

describe("parseRoom", () => {
	it("<c>/share/<s>/<dbPath> 분해", () => {
		expect(parseRoom("ws1/share/g1/a/b.md")).toEqual({ workspaceId: "ws1", spaceId: "g1", dbPath: "a/b.md" });
	});
	it("형식 불일치는 null", () => {
		expect(parseRoom("ws1/mirror/g1/x.md")).toBeNull();
		expect(parseRoom("nopath")).toBeNull();
		expect(parseRoom("ws1/share/g1/")).toBeNull(); // dbPath 비어 있음
	});
});

describe("rejectPlaceholder (기동 가드)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("충분히 긴 비밀번호는 통과(미설정/빈 값도 통과)", () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		rejectPlaceholder("YJS_SECRET", SECRET);
		rejectPlaceholder("YJS_SECRET", undefined);
		expect(exit).not.toHaveBeenCalled();
	});

	it("placeholder/너무 짧은 시크릿은 process.exit(1)", () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		vi.spyOn(console, "error").mockImplementation(() => {});
		rejectPlaceholder("YJS_SECRET", "CHANGE_ME_please");
		rejectPlaceholder("YJS_SECRET", "short");
		expect(exit).toHaveBeenCalledWith(1);
	});
});
