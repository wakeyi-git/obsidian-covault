// @vitest-environment happy-dom
// 세션 종료 스냅샷의 참가자 조건(검토 2026-07 후속): 다른 참가자가 남아 있으면 종료 영속을 생략한다.
// 세션이 계속되는 동안 서버가 스냅샷을 이어가므로, 이때 vault/CouchDB에 쓰면 세션 해제 직후의
// LocalWatcher 업로드가 서버 스냅샷과 rev 경쟁해 충돌 버전 노이즈를 만들던 경로를 막는다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { MarkdownStrategy } from "../../src/core/realtime/mdStrategy";
import { Session, StrategyContext } from "../../src/core/realtime/realtimeTypes";
import { TFile } from "obsidian";

describe("MarkdownStrategy.snapshot — 참가자 잔류 시 종료 영속 생략", () => {
	const strategy = new MarkdownStrategy();
	let doc: Y.Doc;
	let awareness: Awareness;
	let calls: { vaultReads: number; vaultWrites: string[]; uploads: string[]; infos: string[] };
	let ctx: StrategyContext;

	beforeEach(() => {
		doc = new Y.Doc();
		awareness = new Awareness(doc);
		calls = { vaultReads: 0, vaultWrites: [], uploads: [], infos: [] };
		const file = new TFile("공유/노트.md");
		ctx = {
			app: {
				vault: {
					getAbstractFileByPath: () => file,
					read: async () => {
						calls.vaultReads++;
						return "이전 내용";
					},
					process: async (_f: unknown, fn: (data: string) => string) => {
						calls.vaultWrites.push(fn("이전 내용"));
					},
				},
			} as unknown as StrategyContext["app"],
			logger: {
				info: (msg: string) => calls.infos.push(msg),
				warn: () => {},
				ok: () => {},
				error: () => {},
			},
			settings: { displayName: "나", deviceId: "dev-1" },
			getSyncForPath: () => ({
				snapshotNote: async (_path: string, content: string) => {
					calls.uploads.push(content);
					return "uploaded";
				},
				preserveLocalEdit: async () => {},
			}),
		};
	});

	afterEach(() => {
		awareness.destroy();
		doc.destroy();
	});

	function makeSession(): Session {
		const partial = strategy.initSession(doc);
		return { file: "공유/노트.md", kind: "md", ydoc: doc, awareness, bound: new Set(), ...partial } as Session;
	}

	it("다른 참가자가 남아 있으면 vault 쓰기·CouchDB 업로드를 모두 생략한다", async () => {
		const session = makeSession();
		session.ytext!.insert(0, "공동 편집 내용");
		// 원격 참가자 상태 주입(세션 종료 시 자기 상태는 이미 null — 남은 것은 원격뿐).
		(awareness.getStates() as Map<number, unknown>).set(9999, { user: { name: "남은 참가자" } });

		await strategy.snapshot(session, session.file, ctx);
		expect(calls.vaultWrites).toEqual([]);
		expect(calls.uploads).toEqual([]);
		expect(calls.infos.length).toBe(1); // 생략 사유 로그
	});

	it("마지막 참가자면 기존대로 vault 쓰기 + 업로드를 수행한다", async () => {
		const session = makeSession();
		session.ytext!.insert(0, "최종 내용");

		await strategy.snapshot(session, session.file, ctx);
		expect(calls.vaultWrites).toEqual(["최종 내용"]);
		expect(calls.uploads).toEqual(["최종 내용"]);
	});

	it("마지막 참가자여도 빈 내용으로는 덮어쓰지 않는다(기존 안전장치 유지)", async () => {
		const session = makeSession(); // ytext 비어 있음

		await strategy.snapshot(session, session.file, ctx);
		expect(calls.vaultWrites).toEqual([]);
		expect(calls.uploads).toEqual([]);
	});
});
