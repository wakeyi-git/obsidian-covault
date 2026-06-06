import { describe, it, expect } from "vitest";
import { validateSettings } from "./validateSettings";
import { CoVaultSettings } from "./types";

function s(over: Partial<CoVaultSettings> = {}): CoVaultSettings {
	return {
		role: "manager",
		couchdbUrl: "https://nas.example.com",
		realtimeEnabled: false,
		yjsServerUrl: "",
		yjsToken: "",
		yjsSecret: "",
		members: [],
		sharedSpaces: [],
		...over,
	} as CoVaultSettings;
}
const codes = (x: ReturnType<typeof validateSettings>) => x.map((i) => i.code);

describe("validateSettings", () => {
	it("정상 설정은 이슈 없음", () => {
		expect(validateSettings(s())).toEqual([]);
	});

	it("중복 memberId/username/remoteDb를 error로 잡는다", () => {
		const out = validateSettings(
			s({
				members: [
					{ memberId: "a", username: "a", remoteDb: "mirror_a", localRoot: "A" },
					{ memberId: "a", username: "a", remoteDb: "mirror_a", localRoot: "B" },
				] as any,
			}),
		);
		expect(codes(out)).toEqual(expect.arrayContaining(["dup-memberId", "dup-username", "dup-remoteDb"]));
		expect(out.every((i) => (i.code.startsWith("dup") ? i.level === "error" : true))).toBe(true);
	});

	it("학생↔공유 폴더 겹침을 warn으로 잡는다", () => {
		const out = validateSettings(
			s({
				members: [{ memberId: "a", localRoot: "반1" } as any],
				sharedSpaces: [{ id: "g1", folder: "반1/모둠" } as any],
			}),
		);
		expect(codes(out)).toContain("folder-overlap");
	});

	it("CouchDB URL 형식 오류 warn", () => {
		expect(codes(validateSettings(s({ couchdbUrl: "nas.example.com" })))).toContain("couch-url");
	});

	it("Yjs URL이 wss가 아니면 warn", () => {
		expect(codes(validateSettings(s({ yjsServerUrl: "ws://x" })))).toContain("yjs-wss");
	});

	it("실시간 켜짐인데 URL/토큰 누락 warn", () => {
		expect(codes(validateSettings(s({ realtimeEnabled: true })))).toContain("rt-no-url");
		expect(codes(validateSettings(s({ realtimeEnabled: true, yjsServerUrl: "wss://x" })))).toContain("rt-no-token");
		// 시크릿이 있으면 토큰 누락 아님
		expect(
			codes(validateSettings(s({ realtimeEnabled: true, yjsServerUrl: "wss://x", yjsSecret: "k" }))),
		).not.toContain("rt-no-token");
	});

	it("학생 모드에서는 중복/폴더 검사 안 함", () => {
		const out = validateSettings(s({ role: "member" }));
		expect(out).toEqual([]);
	});
});
