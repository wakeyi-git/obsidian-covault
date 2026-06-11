import { describe, it, expect } from "vitest";
import { isDeployableFileName, deployContentHash, shouldOfferInstall, DEPLOYABLE_PLUGIN_FILES } from "./pluginPolicy";

describe("isDeployableFileName (allowlist — 경로 주입 차단)", () => {
	it("허용 파일만 통과", () => {
		for (const n of DEPLOYABLE_PLUGIN_FILES) expect(isDeployableFileName(n)).toBe(true);
	});
	it("그 밖은 거부(traversal·임의 파일)", () => {
		for (const n of ["../evil.js", "plugins/x/main.js", ".obsidian/app.json", "secret.txt", "data.json/../x", ""])
			expect(isDeployableFileName(n)).toBe(false);
	});
});

describe("deployContentHash (멱등 지문)", () => {
	const files = [
		{ name: "main.js", b64: "AAA" },
		{ name: "manifest.json", b64: "BBB" },
	];
	it("파일 순서와 무관하게 결정적", async () => {
		const a = await deployContentHash(files, true, false);
		const b = await deployContentHash([...files].reverse(), true, false);
		expect(a).toBe(b);
	});
	it("내용·정책이 바뀌면 지문도 바뀜", async () => {
		const base = await deployContentHash(files, true, false);
		expect(await deployContentHash(files, false, false)).not.toBe(base); // shareSettings
		expect(await deployContentHash(files, true, true)).not.toBe(base); // managedSettings
		expect(await deployContentHash([{ name: "main.js", b64: "ZZZ" }, files[1]], true, false)).not.toBe(base); // 내용
	});
});

describe("shouldOfferInstall (구성원 안내 판정)", () => {
	const base = { deleted: false, targetMembers: undefined as string[] | undefined, contentHash: "h1" };

	it("미처리 지문이면 안내", () => {
		expect(shouldOfferInstall(base, "m1", undefined)).toBe(true);
		expect(shouldOfferInstall(base, "m1", "old")).toBe(true);
	});
	it("이미 처리한 지문이면 안내 안 함(멱등)", () => {
		expect(shouldOfferInstall(base, "m1", "h1")).toBe(false);
	});
	it("회수(deleted)면 안내 안 함", () => {
		expect(shouldOfferInstall({ ...base, deleted: true }, "m1", undefined)).toBe(false);
	});
	it("targetMembers가 있으면 그 안에 있을 때만", () => {
		const targeted = { ...base, targetMembers: ["m2", "m3"] };
		expect(shouldOfferInstall(targeted, "m1", undefined)).toBe(false);
		expect(shouldOfferInstall(targeted, "m2", undefined)).toBe(true);
	});
	it("빈 targetMembers는 전원", () => {
		expect(shouldOfferInstall({ ...base, targetMembers: [] }, "m1", undefined)).toBe(true);
	});
});
