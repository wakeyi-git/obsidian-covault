import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { MarkdownStrategy, shouldPreserveLocalEdit } from "./mdStrategy";
import { ExcalidrawStrategy, getExcalidrawApi } from "./excalidrawStrategy";
import { Session, StrategyContext } from "./realtimeTypes";

/** snapshot/bind이 쓰는 최소 표면만 갖춘 fake StrategyContext. */
function makeCtx(files: Record<string, string> = {}) {
	const writes: string[] = [];
	const snapshotNote = vi.fn(async (_p: string, _c: string) => "uploaded" as unknown);
	const preserveLocalEdit = vi.fn(async () => {});
	const logs = { ok: [] as string[], warn: [] as string[], error: [] as string[] };
	const ctx: StrategyContext = {
		app: {
			vault: {
				getAbstractFileByPath: (p: string) => (p in files ? mkTFile(p) : null),
				read: async (f: { path: string }) => files[f.path] ?? "",
				process: async (f: { path: string }, fn: (s: string) => string) => {
					files[f.path] = fn(files[f.path] ?? "");
					writes.push(f.path);
					return files[f.path];
				},
			},
		} as unknown as StrategyContext["app"],
		logger: {
			info: () => {},
			warn: (m: string) => logs.warn.push(m),
			ok: (m: string) => logs.ok.push(m),
			error: (m: string) => logs.error.push(m),
		},
		settings: { displayName: "Me", deviceId: "dev-1" },
		getSyncForPath: () => ({ snapshotNote, preserveLocalEdit }),
	};
	return { ctx, files, writes, snapshotNote, preserveLocalEdit, logs };
}

// 하니스 obsidian TFile(전략의 instanceof 검사와 동일 클래스여야 하므로 ESM import 사용).
// 하니스 생성자는 path를 받지만 실제 obsidian 타입은 0인자라, tsc(실 타입)용으로 생성자 시그니처를 좁혀 캐스트한다.
const TFileCtor = TFile as unknown as new (path: string) => TFile;
function mkTFile(path: string) {
	return new TFileCtor(path);
}

function mdSession(yContent: string, file = "shared/a.md"): Session {
	const ydoc = new Y.Doc();
	const ytext = ydoc.getText("content");
	if (yContent) ytext.insert(0, yContent);
	return { file, kind: "md", ydoc, ytext, provider: {} as never, awareness: {} as never, ready: true, bound: new Set() };
}

describe("shouldPreserveLocalEdit (평가 R-A)", () => {
	it("양쪽 비어있지 않고 다르면 보존", () => {
		expect(shouldPreserveLocalEdit("remote", "local")).toBe(true);
	});
	it("같으면 보존 안 함", () => {
		expect(shouldPreserveLocalEdit("same", "same")).toBe(false);
	});
	it("한쪽이라도 비면 보존 안 함(잃을 게 없음)", () => {
		expect(shouldPreserveLocalEdit("", "local")).toBe(false);
		expect(shouldPreserveLocalEdit("remote", "")).toBe(false);
	});
});

describe("MarkdownStrategy.initSession", () => {
	it("Y.Text content + mdPresence 맵 생성", () => {
		const md = new MarkdownStrategy();
		const ydoc = new Y.Doc();
		const got = md.initSession(ydoc);
		expect(got.ytext).toBe(ydoc.getText("content"));
		expect(got.mdPresence).toBeInstanceOf(Map);
	});
});

describe("MarkdownStrategy.snapshot (세션 종료 영속)", () => {
	it("내용이 바뀌면 vault에 쓰고 snapshotNote 업로드", async () => {
		const md = new MarkdownStrategy();
		const h = makeCtx({ "shared/a.md": "old" });
		await md.snapshot(mdSession("hello world"), "shared/a.md", h.ctx);
		expect(h.files["shared/a.md"]).toBe("hello world");
		expect(h.writes).toContain("shared/a.md");
		expect(h.snapshotNote).toHaveBeenCalledWith("shared/a.md", "hello world");
		expect(h.logs.ok.length).toBe(1);
	});

	it("내용이 같으면 vault 쓰기 생략하되 업로드는 시도(skipped-same)", async () => {
		const md = new MarkdownStrategy();
		const h = makeCtx({ "shared/a.md": "same" });
		h.snapshotNote.mockResolvedValueOnce("skipped-same");
		await md.snapshot(mdSession("same"), "shared/a.md", h.ctx);
		expect(h.writes).not.toContain("shared/a.md"); // 변경 없음 → process 미호출
		expect(h.snapshotNote).toHaveBeenCalledWith("shared/a.md", "same");
	});

	it("빈 Y.Text로 기존 내용을 덮지 않음(데이터 손실 방지)", async () => {
		const md = new MarkdownStrategy();
		const h = makeCtx({ "shared/a.md": "existing" });
		await md.snapshot(mdSession(""), "shared/a.md", h.ctx);
		expect(h.files["shared/a.md"]).toBe("existing"); // 보존
		expect(h.writes).not.toContain("shared/a.md");
		expect(h.snapshotNote).not.toHaveBeenCalled();
		expect(h.logs.warn.length).toBe(1);
	});

	it("파일이 없으면 아무 일도 하지 않음", async () => {
		const md = new MarkdownStrategy();
		const h = makeCtx({});
		await md.snapshot(mdSession("x"), "missing.md", h.ctx);
		expect(h.snapshotNote).not.toHaveBeenCalled();
	});
});

describe("MarkdownStrategy.bind 반환(재시도 신호)", () => {
	it("md는 항상 true(재시도 불필요) — 뷰 없어도", () => {
		const md = new MarkdownStrategy();
		const { ctx } = makeCtx();
		expect(md.bind(mdSession("x"), [], ctx)).toBe(true);
	});
});

describe("MarkdownStrategy.unbind", () => {
	it("빈 세션에서 throw 없음", () => {
		const md = new MarkdownStrategy();
		expect(() => md.unbind(mdSession("x"))).not.toThrow();
	});
});

describe("ExcalidrawStrategy.initSession", () => {
	it("Y.Array elements + Y.Map assets 생성", () => {
		const ex = new ExcalidrawStrategy();
		const ydoc = new Y.Doc();
		const got = ex.initSession(ydoc);
		expect(got.yElements).toBe(ydoc.getArray("elements"));
		expect(got.yAssets).toBe(ydoc.getMap("assets"));
	});
});

describe("ExcalidrawStrategy.snapshot (종료 시 디스크 파일 업로드)", () => {
	function exSession(file = "shared/draw.md"): Session {
		const ydoc = new Y.Doc();
		return {
			file,
			kind: "excalidraw",
			ydoc,
			yElements: ydoc.getArray("elements"),
			yAssets: ydoc.getMap("assets"),
			provider: {} as never,
			awareness: {} as never,
			ready: true,
			bound: new Set(),
		};
	}

	it("디스크 내용을 snapshotNote로 업로드", async () => {
		const ex = new ExcalidrawStrategy();
		const h = makeCtx({ "shared/draw.md": "drawing content" });
		await ex.snapshot(exSession(), "shared/draw.md", h.ctx);
		expect(h.snapshotNote).toHaveBeenCalledWith("shared/draw.md", "drawing content");
		expect(h.logs.ok.length).toBe(1);
	});

	it("빈 파일이면 업로드하지 않음", async () => {
		const ex = new ExcalidrawStrategy();
		const h = makeCtx({ "shared/draw.md": "" });
		await ex.snapshot(exSession(), "shared/draw.md", h.ctx);
		expect(h.snapshotNote).not.toHaveBeenCalled();
	});

	it("API 미준비(view에 excalidrawAPI 없음)면 false 반환 — 매니저가 재시도", () => {
		const ex = new ExcalidrawStrategy();
		const { ctx } = makeCtx();
		// view에 excalidrawAPI 없음 + app에 플러그인 없음 → getExcalidrawApi null → bind false.
		expect(ex.bind(exSession(), {}, ctx)).toBe(false);
	});

	it("이미 바인딩된 세션이면 true(재시도 무의미)", () => {
		const ex = new ExcalidrawStrategy();
		const { ctx } = makeCtx();
		const s = exSession();
		s.exBinding = {} as never; // 이미 바인딩됨
		expect(ex.bind(s, {}, ctx)).toBe(true);
	});
});

describe("getExcalidrawApi", () => {
	it("뷰의 excalidrawAPI(onChange 보유)를 반환", () => {
		const api = { onChange: () => {} };
		const view = { excalidrawAPI: api } as never;
		expect(getExcalidrawApi({} as never, view)).toBe(api);
	});
	it("API도 플러그인도 없으면 null", () => {
		const view = {} as never;
		expect(getExcalidrawApi({} as never, view)).toBeNull();
	});
});
