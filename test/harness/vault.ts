// 인메모리 Vault + App. 동기화 엔진(MirrorContext)이 호출하는 vault API만 충실히 구현한다.
import { TFile, TFolder, TAbstractFile, normalizePath } from "obsidian";

function byteLen(s: string): number {
	return new TextEncoder().encode(s).length;
}

interface Entry {
	file: TFile;
	content?: string; // markdown 등 텍스트
	binary?: ArrayBuffer; // 첨부
}

/** Obsidian Vault의 인메모리 대체물. 실제 엔진이 그대로 사용한다. */
export class InMemoryVault {
	private files = new Map<string, Entry>();
	private folders = new Set<string>();
	constructor(private vaultName = "test-vault") {}

	getName(): string {
		return this.vaultName;
	}

	/** 실제 Obsidian처럼 즉시 부모 폴더가 없으면 생성 거부(중첩 경로 적용 누락 검출용). */
	private requireParent(p: string, op: string): void {
		const idx = p.lastIndexOf("/");
		if (idx <= 0) return; // 루트 직속이면 부모 검사 불필요
		const parent = p.slice(0, idx);
		if (!this.folders.has(parent)) throw new Error(`${op}: missing parent folder: ${parent}`);
	}

	/** 경로의 모든 조상 폴더를 폴더 집합에 등록(seed 등 초기 상태 구성용). */
	private registerAncestors(p: string): void {
		const parts = p.split("/").filter(Boolean);
		let cur = "";
		for (let i = 0; i < parts.length - 1; i++) {
			cur = cur ? `${cur}/${parts[i]}` : parts[i];
			this.folders.add(cur);
		}
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		const p = normalizePath(path);
		const e = this.files.get(p);
		if (e) return e.file;
		if (this.folders.has(p)) return Object.assign(new TFolder(p), {});
		return null;
	}

	async read(file: TFile): Promise<string> {
		const e = this.files.get(normalizePath(file.path));
		if (!e || e.content == null) throw new Error(`read: not a text file: ${file.path}`);
		return e.content;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.read(file);
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		const e = this.files.get(normalizePath(file.path));
		if (!e || e.binary == null) throw new Error(`readBinary: not a binary file: ${file.path}`);
		return e.binary;
	}

	/** 백그라운드 atomic 쓰기(가이드라인 권장 API). */
	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const p = normalizePath(file.path);
		const e = this.files.get(p);
		if (!e || e.content == null) throw new Error(`process: not a text file: ${file.path}`);
		const next = fn(e.content);
		e.content = next;
		e.file.stat.size = byteLen(next);
		e.file.stat.mtime = Date.now(); // 실제 Obsidian처럼 수정 시각 갱신(증분 스캔이 의존)
		this.emit("modify", e.file);
		return next;
	}

	async create(path: string, content: string): Promise<TFile> {
		const p = normalizePath(path);
		if (this.files.has(p)) throw new Error(`create: already exists: ${p}`);
		this.requireParent(p, "create");
		const file = new TFile(p, byteLen(content));
		this.files.set(p, { file, content });
		this.emit("create", file);
		return file;
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		const p = normalizePath(path);
		if (this.files.has(p)) throw new Error(`createBinary: already exists: ${p}`);
		this.requireParent(p, "createBinary");
		const file = new TFile(p, data.byteLength);
		this.files.set(p, { file, binary: data });
		this.emit("create", file);
		return file;
	}

	async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
		const e = this.files.get(normalizePath(file.path));
		if (!e) throw new Error(`modifyBinary: missing: ${file.path}`);
		e.binary = data;
		e.file.stat.size = data.byteLength;
		e.file.stat.mtime = Date.now();
		this.emit("modify", e.file);
	}

	async createFolder(path: string): Promise<TFolder> {
		const p = normalizePath(path);
		this.requireParent(p, "createFolder");
		this.folders.add(p);
		return new TFolder(p);
	}

	/** trash(file, false) = vault 내 삭제. 테스트에선 단순 제거. */
	async trash(file: TFile, _system: boolean): Promise<void> {
		this.files.delete(normalizePath(file.path));
		this.emit("delete", file);
	}
	async delete(file: TAbstractFile): Promise<void> {
		if (file instanceof TFolder) {
			await this.deleteFolder(file.path);
			return;
		}
		this.files.delete(normalizePath(file.path));
		this.emit("delete", file);
	}

	/**
	 * 폴더 삭제(Obsidian 거동 모사): 내부 파일을 조용히 제거하고 **폴더 1건의 delete 이벤트만** 낸다 —
	 * 파일별 delete 이벤트는 내지 않는다(이게 폴더 삭제 전파 버그의 원인). 중첩 하위 폴더도 함께 제거.
	 */
	async deleteFolder(path: string): Promise<void> {
		const p = normalizePath(path);
		for (const key of [...this.files.keys()]) {
			if (key === p || key.startsWith(p + "/")) this.files.delete(key);
		}
		for (const f of [...this.folders]) {
			if (f === p || f.startsWith(p + "/")) this.folders.delete(f);
		}
		this.emit("delete", new TFolder(p));
	}

	getFiles(): TFile[] {
		return [...this.files.values()].map((e) => e.file);
	}
	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((f) => f.extension === "md");
	}

	/** fileManager.renameFile 구현 위임. 폴더는 내부 항목을 조용히 옮기고 폴더 rename 이벤트 1건만 낸다. */
	rename(file: TAbstractFile, toPath: string): void {
		const from = normalizePath(file.path);
		const to = normalizePath(toPath);
		this.requireParent(to, "rename");
		if (file instanceof TFolder) {
			if (!this.folders.has(from)) throw new Error(`rename: missing folder: ${from}`);
			const movedFolders = [...this.folders].filter((path) => path === from || path.startsWith(from + "/"));
			for (const path of movedFolders) this.folders.delete(path);
			for (const path of movedFolders) this.folders.add(to + path.slice(from.length));
			for (const [path, entry] of [...this.files]) {
				if (!path.startsWith(from + "/")) continue;
				const next = to + path.slice(from.length);
				this.files.delete(path);
				entry.file.path = next;
				entry.file.name = next.split("/").pop() ?? next;
				const dot = entry.file.name.lastIndexOf(".");
				entry.file.extension = dot > 0 ? entry.file.name.slice(dot + 1) : "";
				entry.file.basename = dot > 0 ? entry.file.name.slice(0, dot) : entry.file.name;
				this.files.set(next, entry);
			}
			file.path = to;
			file.name = to.split("/").pop() ?? to;
			this.emit("rename", file, from);
			return;
		}
		const e = this.files.get(from);
		if (!e) throw new Error(`rename: missing: ${from}`);
		this.files.delete(from);
		e.file.path = to;
		e.file.name = to.split("/").pop() ?? to;
		this.files.set(to, e);
		this.emit("rename", e.file, from);
	}

	// --- 이벤트 API(LocalWatcher 호환) — 실제 Obsidian처럼 create/modify/rename/delete를 발화한다.
	// 리스너를 등록하지 않은 테스트(대부분)에는 영향이 없다(emit이 no-op). seed*는 초기 상태 구성이라 발화하지 않는다.
	private listeners = new Map<string, Map<number, (...args: any[]) => void>>();
	private nextRef = 1;
	on(name: string, cb: (...args: any[]) => unknown): { id: number; name: string } {
		const id = this.nextRef++;
		let m = this.listeners.get(name);
		if (!m) {
			m = new Map();
			this.listeners.set(name, m);
		}
		m.set(id, cb);
		return { id, name };
	}
	offref(ref: { id: number; name: string } | undefined | null): void {
		if (!ref) return;
		this.listeners.get(ref.name)?.delete(ref.id);
	}
	private emit(name: string, ...args: unknown[]): void {
		const m = this.listeners.get(name);
		if (!m) return;
		for (const cb of [...m.values()]) cb(...args);
	}

	// --- 테스트 헬퍼 ---
	has(path: string): boolean {
		return this.files.has(normalizePath(path));
	}
	textOf(path: string): string | undefined {
		return this.files.get(normalizePath(path))?.content;
	}
	/** 엔진을 거치지 않고 직접 파일을 심는다(초기 상태 구성용). */
	seed(path: string, content: string): TFile {
		const p = normalizePath(path);
		this.registerAncestors(p);
		const file = new TFile(p, byteLen(content));
		this.files.set(p, { file, content });
		return file;
	}
	seedBinary(path: string, data: ArrayBuffer): TFile {
		const p = normalizePath(path);
		this.registerAncestors(p);
		const file = new TFile(p, data.byteLength);
		this.files.set(p, { file, binary: data });
		return file;
	}
	allPaths(): string[] {
		return [...this.files.keys()];
	}
}

/** CoreServices가 받는 App 형태. vault + fileManager만 쓴다. */
export function makeApp(appId: string, vaultName: string): { app: any; vault: InMemoryVault } {
	const vault = new InMemoryVault(vaultName);
	const app = {
		appId,
		vault,
		fileManager: {
			renameFile: async (file: TAbstractFile, toPath: string) => vault.rename(file, toPath),
		},
		workspace: {
			onLayoutReady: (cb: () => void) => cb(), // 테스트에선 항상 준비됨
		},
	};
	return { app, vault };
}
