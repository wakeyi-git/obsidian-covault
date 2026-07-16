import { describe, it, expect } from "vitest";
import {
	isDeployableFileName,
	deployContentHash,
	shouldOfferInstall,
	DEPLOYABLE_PLUGIN_FILES,
	isSafePluginId,
	validatePluginDeployDoc,
} from "./pluginPolicy";
import { utf8ToB64 } from "../util/b64";

describe("isDeployableFileName (allowlist — 경로 주입 차단)", () => {
	it("허용 파일만 통과", () => {
		for (const n of DEPLOYABLE_PLUGIN_FILES) expect(isDeployableFileName(n)).toBe(true);
	});
	it("그 밖은 거부(traversal·임의 파일)", () => {
		for (const n of ["../evil.js", "plugins/x/main.js", ".obsidian/app.json", "secret.txt", "data.json/../x", ""])
			expect(isDeployableFileName(n)).toBe(false);
	});
});

describe("isSafePluginId (설치 디렉터리 경계)", () => {
	it("일반 플러그인 id만 통과", () => {
		for (const id of ["obsidian-git", "calendar_2", "plugin.name"]) expect(isSafePluginId(id)).toBe(true);
	});
	it("상위 경로·절대/중첩 경로·빈 id를 거부", () => {
		for (const id of ["", ".", "..", "../evil", "x/y", "x\\y", "/tmp/x", " x"]) expect(isSafePluginId(id)).toBe(false);
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

describe("validatePluginDeployDoc (수신 신뢰 경계)", () => {
	async function validDoc() {
		const files = [
			{ name: "manifest.json", b64: utf8ToB64(JSON.stringify({ id: "safe-plugin", name: "Safe Plugin", version: "1.2.3" })) },
			{ name: "main.js", b64: utf8ToB64("module.exports = {}") },
		];
		return {
			_id: "plugindeploy:safe-plugin",
			type: "plugindeploy",
			schemaVersion: 1,
			workspaceId: "ws1",
			pluginId: "safe-plugin",
			pluginName: "Safe Plugin",
			version: "1.2.3",
			files,
			shareSettings: false,
			managedSettings: false,
			contentHash: await deployContentHash(files, false, false),
			deployedBy: "manager",
			deployedAt: "2026-07-16T00:00:00.000Z",
		};
	}

	it("정상 문서와 workspace를 검증", async () => {
		const doc = await validDoc();
		expect(await validatePluginDeployDoc(doc, "ws1")).toBeNull();
		expect(await validatePluginDeployDoc(doc, "other")).toBe("workspace id mismatch");
	});

	it("경로 주입·CoVault 자체 덮어쓰기·문서 id 불일치를 거부", async () => {
		const doc = await validDoc();
		expect(await validatePluginDeployDoc({ ...doc, pluginId: "../evil" })).toBe("unsafe plugin id");
		expect(await validatePluginDeployDoc({ ...doc, pluginId: "covault", _id: "plugindeploy:covault" })).toBe("unsafe plugin id");
		expect(await validatePluginDeployDoc({ ...doc, _id: "plugindeploy:other" })).toBe("document id does not match plugin id");
	});

	it("중복/임의/누락 파일과 settings 정책 위반을 거부", async () => {
		const doc = await validDoc();
		expect(await validatePluginDeployDoc({ ...doc, files: [...doc.files, doc.files[1]] })).toBe("duplicate file name");
		expect(await validatePluginDeployDoc({ ...doc, files: [...doc.files, { name: "../evil.js", b64: "" }] })).toBe("disallowed file name");
		expect(await validatePluginDeployDoc({ ...doc, files: doc.files.filter((file) => file.name !== "main.js") })).toBe("missing main.js");
		expect(await validatePluginDeployDoc({ ...doc, managedSettings: true })).toBe("managed settings were not shared");
	});

	it("manifest 신원과 콘텐츠 지문 변조를 거부", async () => {
		const doc = await validDoc();
		const mismatched = {
			...doc,
			files: doc.files.map((file) =>
				file.name === "manifest.json"
					? { ...file, b64: utf8ToB64(JSON.stringify({ id: "other", name: "Safe Plugin", version: "1.2.3" })) }
					: file,
			),
		};
		expect(await validatePluginDeployDoc(mismatched)).toBe("manifest identity mismatch");
		expect(await validatePluginDeployDoc({ ...doc, contentHash: "0".repeat(64) })).toBe("content hash mismatch");
	});
});
