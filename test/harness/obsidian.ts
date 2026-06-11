// 통합 테스트용 obsidian mock. vitest.config.ts의 alias("obsidian" → 이 파일)로 연결된다.
// 동기화 엔진이 실제로 import하는 최소 표면만 제공한다(TFile/TFolder/normalizePath/Notice/Platform/App).
// 엔진이 쓰는 vault I/O는 InMemoryVault(vault.ts)가 이 클래스들로 구현한다.

export abstract class TAbstractFile {
	path: string;
	name: string;
	parent: TFolder | null = null;
	constructor(path: string) {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot(): boolean {
		return this.path === "" || this.path === "/";
	}
}

export class TFile extends TAbstractFile {
	extension: string;
	basename: string;
	stat: { size: number; mtime: number; ctime: number };
	constructor(path: string, size = 0) {
		super(path);
		const dot = this.name.lastIndexOf(".");
		this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		// 실제 Obsidian처럼 생성 시각을 stat에 기록한다(증분 스캔·tombstone mtime 비교가 의존).
		const now = Date.now();
		this.stat = { size, mtime: now, ctime: now };
	}
}

export class Notice {
	constructor(_message?: string | DocumentFragment, _timeout?: number) {}
	setMessage(): this {
		return this;
	}
	hide(): void {}
}

/** Obsidian normalizePath 근사: 역슬래시→슬래시, 중복 슬래시 축약, 앞뒤 슬래시 제거. */
export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.trim();
}

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isMobileApp: false,
	isDesktopApp: true,
};

// 엔진이 타입으로만 참조하는 것들(런타임 값 불필요하지만 import 해소를 위해 stub).
export class App {}
export class Plugin {}
export class Component {}
export type EventRef = unknown;
export class Setting {}
export class SettingGroup {}
export class PluginSettingTab {}
export class Modal {}
export class MarkdownView {}
export class ItemView {}
