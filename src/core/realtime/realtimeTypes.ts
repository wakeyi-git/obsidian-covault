import { TFile, View } from "obsidian";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { EditorView } from "@codemirror/view";
import { PresenceChips } from "./presenceChips";
import { ExcalidrawBinding, ExcalidrawImperativeApi } from "./excalidrawBinding";
import { RealtimeProvider } from "./providerFactory";

/** 한 문서의 실시간 세션 상태. md/excalidraw가 일부 필드를 공유한다. */
export interface Session {
	file: string;
	kind: "md" | "excalidraw";
	ydoc: Y.Doc;
	ytext?: Y.Text; // md
	yElements?: Y.Array<Y.Map<any>>; // excalidraw 요소
	yAssets?: Y.Map<any>; // excalidraw 이미지 asset
	provider: RealtimeProvider;
	/** 직접 생성해 provider에 주입한 awareness — provider.awareness의 null 타입을 피하고 바인딩에 그대로 쓴다. */
	awareness: Awareness;
	ready: boolean; // 서버 동기화 완료(시드는 서버 onLoadDocument 담당) → 바인딩 가능
	bound: Set<EditorView>; // md: 바인딩된 CM6
	mdPresence?: Map<EditorView, PresenceChips>; // md: 뷰별 참가자 칩 오버레이
	exBinding?: ExcalidrawBinding; // excalidraw 바인딩
}

/** Excalidraw 뷰(타입 느슨). file과 imperative API 접근만 사용. */
export interface ExcalidrawLikeView extends View {
	file?: TFile;
	excalidrawAPI?: ExcalidrawImperativeApi;
}

/** 실시간 스냅샷을 받을 대상(담당 MirrorSync). main이 경로로 해결해 준다. */
export interface SnapshotTarget {
	snapshotNote(localPath: string, content: string): Promise<unknown>;
	/** 바인딩이 에디터 내용을 Y.Text로 교체하기 전, 미업로드 로컬 편집을 버전 히스토리에 보존(평가 R-A). */
	preserveLocalEdit(localPath: string, content: string): Promise<void>;
}

/** 실시간 로거(RealtimeManager가 쓰는 메서드만). */
export interface RealtimeLogger {
	info(msg: string, notice?: boolean): void;
	warn(msg: string, notice?: boolean): void;
	ok(msg: string, notice?: boolean): void;
	error(msg: string, notice?: boolean): void;
}

/** 바인딩 전략이 세션 작업에 필요한 주변 의존성(매니저가 주입). */
export interface StrategyContext {
	app: import("obsidian").App;
	logger: RealtimeLogger;
	/** displayName·deviceId 등 바인딩에 쓰는 설정. */
	settings: { displayName: string; deviceId: string };
	/** 로컬 경로 → 담당 동기화 링크(스냅샷·로컬 편집 보존). */
	getSyncForPath: (localPath: string) => SnapshotTarget | undefined;
}

/** md(글자 단위)·excalidraw(요소 단위) 바인딩의 kind별 동작을 캡슐화(평가 P2-3b). */
export interface EditorBindingStrategy {
	readonly kind: "md" | "excalidraw";
	/** 세션의 Y 구조(및 md presence 맵) 생성 — startSession이 공통 필드와 병합한다. */
	initSession(ydoc: Y.Doc): Partial<Session>;
	/**
	 * 열린 뷰(들)에 Yjs 바인딩. target은 kind에 맞는 뷰(매니저가 kind 일치 확인 후 호출).
	 * 반환값: 바인딩 완료(또는 재시도 무의미)면 true, 아직 준비 안 돼 재시도가 필요하면 false
	 * (excalidraw 뷰의 imperative API 마운트 지연 대응 — 매니저가 짧게 재시도한다).
	 */
	bind(session: Session, target: unknown, ctx: StrategyContext): boolean;
	/** 세션 종료 시 바인딩 해제(에디터·오버레이 정리). */
	unbind(session: Session): void;
	/** 세션 종료 영속(스냅샷). 매니저가 persist=true일 때만 호출. */
	snapshot(session: Session, path: string, ctx: StrategyContext): Promise<void>;
}
