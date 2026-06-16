// 플러그인 배포 설치의 플랫폼 정책: 모바일에서도 설치 가능하되 데스크톱 전용(isDesktopOnly) 플러그인만
// 모바일에서 건너뛴다. (과거엔 모든 설치를 데스크톱 전용으로 차단했다.)
import { describe, it, expect, afterEach } from "vitest";
import { Platform } from "obsidian"; // 하니스 mock — isMobile 토글 가능
import { deployedPluginIsDesktopOnly, deployRunnableHere } from "../../src/core/plugindeploy/configInstall";
import { utf8ToB64 } from "../../src/core/util/b64";
import { PluginDeployDoc } from "../../src/core/model/types";

function deployDoc(manifest: Record<string, unknown> | null): PluginDeployDoc {
	const files = manifest ? [{ name: "manifest.json", b64: utf8ToB64(JSON.stringify(manifest)) }] : [];
	return { pluginId: "p", pluginName: "P", files } as unknown as PluginDeployDoc;
}

describe("플러그인 배포 — 플랫폼 정책", () => {
	afterEach(() => {
		Platform.isMobile = false; // 다른 테스트로 누수 방지
	});

	it("manifest의 isDesktopOnly를 읽는다(누락/오류/false는 false)", () => {
		expect(deployedPluginIsDesktopOnly(deployDoc({ id: "p", isDesktopOnly: true }))).toBe(true);
		expect(deployedPluginIsDesktopOnly(deployDoc({ id: "p", isDesktopOnly: false }))).toBe(false);
		expect(deployedPluginIsDesktopOnly(deployDoc({ id: "p" }))).toBe(false);
		expect(deployedPluginIsDesktopOnly(deployDoc(null))).toBe(false);
		expect(deployedPluginIsDesktopOnly({ files: [{ name: "manifest.json", b64: "%%bad%%" }] } as unknown as PluginDeployDoc)).toBe(false);
	});

	it("데스크톱에서는 데스크톱 전용 플러그인도 설치 가능", () => {
		Platform.isMobile = false;
		expect(deployRunnableHere(deployDoc({ id: "p", isDesktopOnly: true }))).toBe(true);
		expect(deployRunnableHere(deployDoc({ id: "p", isDesktopOnly: false }))).toBe(true);
	});

	it("모바일에서는 일반 플러그인은 설치 가능, 데스크톱 전용만 건너뛴다", () => {
		Platform.isMobile = true;
		expect(deployRunnableHere(deployDoc({ id: "p", isDesktopOnly: false }))).toBe(true);
		expect(deployRunnableHere(deployDoc({ id: "p" }))).toBe(true);
		expect(deployRunnableHere(deployDoc({ id: "p", isDesktopOnly: true }))).toBe(false);
	});
});
