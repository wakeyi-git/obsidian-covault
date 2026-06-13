import { App, TFile } from "obsidian";
import { Logger } from "../../core/log/Logger";
import { CoVaultSettings } from "../../settings/types";
import { ClassroomStore } from "../../core/classroom/ClassroomStore";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { PouchDocBase } from "../../core/model/types";
import { ensureParentFolders } from "../../core/vault/folders";

/**
 * 학급 운영 도메인 컨트롤러(Notice/Assignment/Routine/Message)가 공유하는 의존성. `settings`는
 * loadSettings/import에서 객체가 교체되므로 반드시 getter로 제공한다(값 캡처 금지).
 * classroom/app/logger는 1회 생성되어 안정적. (평가 P2-3 — ClassroomController 갓 클래스 분할.)
 */
export interface ClassroomDeps {
	app: App;
	logger: Logger;
	classroom: ClassroomStore;
	settings(): CoVaultSettings;
	couchPassword(): string;
	homeroomReady(): boolean;
	homeroomFolder(): string | null;
	saveSettings(): Promise<void>;
	requestApply(): void;
	memberSyncByRemoteDb(db: string): MirrorSync | undefined;
	studentMirrorSync(): MirrorSync | undefined;
	/** 학급 공동 공간(homeroom) remoteDb — 명명 그룹 대화방이 사는 곳. 미지정이면 null. */
	homeroomDb(): string | null;
}

// --- 도메인 컨트롤러 공통 vault·집계 헬퍼(분할 전 ClassroomController의 private 메서드 추출) ---

/** vault 텍스트 파일 읽기(없거나 비-파일이면 null). */
export async function readVaultText(d: ClassroomDeps, path: string): Promise<string | null> {
	const f = d.app.vault.getAbstractFileByPath(path);
	return f instanceof TFile ? await d.app.vault.read(f) : null;
}

/** 부모 폴더 보장 후 파일이 없을 때만 생성. */
export async function writeFileIfAbsent(d: ClassroomDeps, path: string, body: string): Promise<void> {
	await ensureParentFolders(d.app, path);
	if (!d.app.vault.getAbstractFileByPath(path)) await d.app.vault.create(path, body);
}

/** vault 경로를 편집창에서 연다(파일일 때만). */
export async function openVaultPath(d: ClassroomDeps, path: string): Promise<void> {
	const f = d.app.vault.getAbstractFileByPath(path);
	if (f instanceof TFile) await d.app.workspace.getLeaf(false).openFile(f, { active: true });
}

/** 파일의 현재 프론트매터(없으면 undefined). */
export function frontmatterOf(d: ClassroomDeps, path: string): Record<string, unknown> | undefined {
	const f = d.app.vault.getAbstractFileByPath(path);
	return f instanceof TFile ? (d.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined) : undefined;
}

/**
 * 전 구성원 mirror DB를 순회하며 prefix로 문서를 수집(교사 통계용). 미동기화 멤버는 건너뛴다.
 * 기본은 deleted 제외, includeDeleted=true면 전부(기존 listAllRoutineStates 거동 보존).
 */
export async function collectFromMemberMirrors<T extends PouchDocBase>(
	d: ClassroomDeps,
	prefix: string,
	opts?: { includeDeleted?: boolean },
): Promise<T[]> {
	const out: T[] = [];
	for (const m of d.settings().members) {
		if (!m.memberId) continue;
		const sync = d.memberSyncByRemoteDb(m.remoteDb);
		if (!sync) continue;
		out.push(...(await sync.ctx.pouch.allDocsByPrefix<T>(prefix)));
	}
	return opts?.includeDeleted ? out : out.filter((doc) => !(doc as { deleted?: boolean }).deleted);
}
