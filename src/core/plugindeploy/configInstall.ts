import { App, Platform } from "obsidian";
import { PluginDeployDoc, PluginDeployFile } from "../model/types";
import { DEPLOYABLE_PLUGIN_FILES, SETTINGS_FILE, REQUIRED_FILES, isDeployableFileName } from "./pluginPolicy";
import { b64ToUtf8, utf8ToB64 } from "../util/b64";

/**
 * 플러그인 배포의 `.obsidian` 접근을 **단 한 곳에 격리**한 설치/읽기 레이어(정책 엔진 P2).
 *
 * CoVault는 원래 Vault API만 쓰고 `.obsidian`을 동기화에서 이중 배제한다. 이 모듈만 예외적으로
 * `app.vault.adapter`(`.obsidian` 직접 읽기/쓰기)와 `app.plugins`(활성화)에 접근하며,
 * **화이트리스트된 파일명만** 다뤄 경로 traversal·임의 파일 쓰기를 차단한다.
 * 동기화 엔진과는 무관 — 배포는 push-once 채널이고 설치는 구성원 확인 후 1회성이다.
 */

interface DataAdapterLike {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	write(path: string, data: string): Promise<void>;
	read(path: string): Promise<string>;
}
interface PluginManifestLike {
	id: string;
	name: string;
	version: string;
}
interface PluginsLike {
	manifests: Record<string, PluginManifestLike>;
	enabledPlugins?: Set<string>;
	loadManifests?: () => Promise<void>;
	enablePlugin?: (id: string) => Promise<void>;
}

function adapter(app: App): DataAdapterLike {
	return (app.vault as unknown as { adapter: DataAdapterLike }).adapter;
}
function pluginsApi(app: App): PluginsLike | null {
	return (app as unknown as { plugins?: PluginsLike }).plugins ?? null;
}

/** P2는 데스크톱 전용 — 모바일은 `.obsidian` 쓰기·플러그인 관리가 제약적이고 위험. */
export function pluginInstallSupported(): boolean {
	return !Platform.isMobile;
}

/** 현재 사용자 식별(자기 자신 배포 제외) — CoVault 본체. */
export const SELF_PLUGIN_ID = "covault";

export interface InstalledPlugin {
	id: string;
	name: string;
	version: string;
	enabled: boolean;
}

/** 설치된 커뮤니티 플러그인 목록(CoVault 자신 제외). app.plugins.manifests 기반. */
export function listInstalledCommunityPlugins(app: App): InstalledPlugin[] {
	const p = pluginsApi(app);
	if (!p?.manifests) return [];
	const enabled = p.enabledPlugins ?? new Set<string>();
	return Object.values(p.manifests)
		.filter((m) => m && m.id && m.id !== SELF_PLUGIN_ID)
		.map((m) => ({ id: m.id, name: m.name || m.id, version: m.version || "", enabled: enabled.has(m.id) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 운영자 기기의 `.obsidian/plugins/<id>/`에서 배포 파일을 읽는다(allowlist만, 모두 텍스트→base64).
 * manifest.json·main.js가 없으면 throw(배포 불가). includeSettings면 data.json도 포함.
 */
export async function readInstalledPlugin(app: App, pluginId: string, includeSettings: boolean): Promise<PluginDeployFile[]> {
	const a = adapter(app);
	const dir = `.obsidian/plugins/${pluginId}`;
	const out: PluginDeployFile[] = [];
	for (const name of DEPLOYABLE_PLUGIN_FILES) {
		if (name === SETTINGS_FILE && !includeSettings) continue;
		const path = `${dir}/${name}`;
		if (!(await a.exists(path))) {
			if ((REQUIRED_FILES as readonly string[]).includes(name)) {
				throw new Error(`${pluginId}: missing ${name}`);
			}
			continue;
		}
		out.push({ name, b64: utf8ToB64(await a.read(path)) });
	}
	return out;
}

/**
 * 배포 문서를 `.obsidian/plugins/<id>/`에 설치(allowlist 파일만). enable=켜기(community-plugins.json union +
 * 로드)까지. data.json(설정)은 forceSettings(=managedSettings)이거나 최초 설치일 때만 써 구성원 설정을 보존한다.
 */
export async function installDeployedPlugin(
	app: App,
	doc: PluginDeployDoc,
	opts: { enable: boolean; forceSettings: boolean },
): Promise<void> {
	const a = adapter(app);
	const dir = `.obsidian/plugins/${doc.pluginId}`;
	if (!(await a.exists(dir))) await a.mkdir(dir);
	for (const f of doc.files) {
		if (!isDeployableFileName(f.name)) continue; // 방어 — allowlist 외 무시(경로 주입 차단)
		const path = `${dir}/${f.name}`;
		if (f.name === SETTINGS_FILE) {
			// 설정은 managed(forceSettings)이거나 최초 설치(파일 없음)만 — 구성원이 바꾼 설정을 덮지 않는다.
			if ((await a.exists(path)) && !opts.forceSettings) continue;
		}
		await a.write(path, b64ToUtf8(f.b64));
	}
	if (opts.enable) {
		const p = pluginsApi(app);
		// enablePlugin이 community-plugins.json에 union으로 추가하고 즉시 로드한다(BRAT 등과 동일 경로).
		if (p?.loadManifests && p?.enablePlugin) {
			await p.loadManifests();
			await p.enablePlugin(doc.pluginId);
		}
	}
}
