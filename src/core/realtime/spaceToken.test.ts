import { describe, it, expect } from "vitest";
import { mintSpaceToken, verifySpaceToken } from "./spaceToken";
import { clientColor } from "./clientColor";

const SECRET = "test-secret-key";
const NOW = 1_700_000_000;

describe("spaceToken", () => {
	it("발급한 토큰은 같은 secret·workspaceId·spaceId로 검증된다", async () => {
		const tok = await mintSpaceToken(SECRET, { workspaceId: "c1", spaceId: "s1" });
		expect(await verifySpaceToken(SECRET, tok, "c1", "s1", NOW)).toBe(true);
	});

	it("다른 spaceId면 거부(공간 간 격리)", async () => {
		const tok = await mintSpaceToken(SECRET, { workspaceId: "c1", spaceId: "s1" });
		expect(await verifySpaceToken(SECRET, tok, "c1", "s2", NOW)).toBe(false);
	});

	it("다른 workspaceId면 거부", async () => {
		const tok = await mintSpaceToken(SECRET, { workspaceId: "c1", spaceId: "s1" });
		expect(await verifySpaceToken(SECRET, tok, "c2", "s1", NOW)).toBe(false);
	});

	it("다른 secret이면 거부", async () => {
		const tok = await mintSpaceToken(SECRET, { workspaceId: "c1", spaceId: "s1" });
		expect(await verifySpaceToken("wrong-secret", tok, "c1", "s1", NOW)).toBe(false);
	});

	it("서명/payload 변조 시 거부", async () => {
		const tok = await mintSpaceToken(SECRET, { workspaceId: "c1", spaceId: "s1" });
		const tampered = tok.slice(0, -2) + (tok.endsWith("aa") ? "bb" : "aa");
		expect(await verifySpaceToken(SECRET, tampered, "c1", "s1", NOW)).toBe(false);
	});

	it("exp 지난 토큰은 거부, 유효 기간 내면 통과", async () => {
		const tok = await mintSpaceToken(SECRET, { workspaceId: "c1", spaceId: "s1", exp: NOW + 100 });
		expect(await verifySpaceToken(SECRET, tok, "c1", "s1", NOW + 50)).toBe(true);
		expect(await verifySpaceToken(SECRET, tok, "c1", "s1", NOW + 200)).toBe(false);
	});

	it("형식이 잘못된 토큰은 거부", async () => {
		expect(await verifySpaceToken(SECRET, "no-dot-here", "c1", "s1", NOW)).toBe(false);
		expect(await verifySpaceToken(SECRET, "", "c1", "s1", NOW)).toBe(false);
	});
});

describe("clientColor (Excalidraw getClientColor 동일 공식)", () => {
	// Excalidraw clients.ts와 정확히 같은 값이어야 커서·선택 영역과 칩 색이 일치한다.
	it("알려진 clientId에 대해 Excalidraw와 동일한 HSL을 만든다", () => {
		expect(clientColor("0")).toBe("hsl(110, 100%, 83%)");
		expect(clientColor("1")).toBe("hsl(120, 100%, 83%)");
		expect(clientColor("12345")).toBe("hsl(20, 100%, 83%)");
		expect(clientColor("987654321")).toBe("hsl(270, 100%, 83%)");
	});

	it("결정적이고 hue는 10단위(0..360)", () => {
		const m = clientColor("abc").match(/^hsl\((\d+), 100%, 83%\)$/);
		expect(m).not.toBeNull();
		const hue = Number(m![1]);
		expect(hue % 10).toBe(0);
		expect(hue).toBeGreaterThanOrEqual(0);
		expect(hue).toBeLessThanOrEqual(360);
	});
});
