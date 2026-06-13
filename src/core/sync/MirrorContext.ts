import { TFile, normalizePath as obsidianNormalize } from "obsidian";
import { CoreServices } from "../CoreServices";
import { PouchService } from "../couch/PouchService";
import { NoteDoc, AssetDoc, assetId } from "../model/types";
import { sha256 } from "../hash/hash";
import { dbPathToLocal, localPathToDb, normalizePath, validateVaultPath, insertLabelBeforeExt } from "../path/path";
import { VersionStore } from "./VersionStore";
import { ensureParentFolders } from "../vault/folders";
import { t } from "../../i18n";

/** 파일명에 쓸 수 없는 문자를 _로 치환. */
function sanitizeFileLabel(s: string): string {
	return (s || "").replace(/[\\/:*?"<>|.]/g, "_").trim() || t("common.peer");
}

/** 링크(학생↔mirror) 동기화 상태. 기술문서 §12.6 대시보드용. */
export interface LinkStatus {
	lastUploadAt?: number; // 마지막 로컬→원격 업로드 시각
	lastDownloadAt?: number; // 마지막 원격→로컬 적용 시각
	lastError?: string;
	state: "idle" | "syncing" | "offline" | "error" | "disabled";
}

/**
 * 하나의 member↔mirror 링크의 컨텍스트 + 공유 헬퍼. 기술문서 §9 / §16 / §14.2.
 *
 * 경로 매핑, vault 입출력, NoteDoc 빌드, 동기화 상태(syncState)와 changes 체크포인트(lastSeq)를
 * 한곳에서 다룬다. Applier/Watcher/Subscriber/FullSync가 공유한다.
 * Phase 2에서 Manager는 학생마다 이 컨텍스트를 하나씩 갖는다.
 */
export class MirrorContext {
	/** 이 링크의 실시간 상태(대시보드용). 컴포넌트들이 직접 갱신한다. */
	readonly status: LinkStatus = { state: "idle" };
	/**
	 * 충돌 문서 id(note:/asset:) 증분 집계(평가 P-1). 시작 시 1회 전수 채움(MirrorSync) 후
	 * LocalApplier의 changes(conflicts:true)가 증분 유지한다 — 대시보드 카운트 폴링이
	 * 5초마다 전 문서를 본문 포함으로 적재하던 비용을 제거한다.
	 */
	readonly conflictIds = new Set<string>();

	/** 사용자용 버전 히스토리(마크다운 스냅샷). 보고서 §1 P1. */
	readonly versions: VersionStore = new VersionStore(this);

	constructor(
		public readonly core: CoreServices,
		public readonly memberId: string,
		public readonly memberName: string,
		public readonly localRoot: string,
		public readonly remoteDb: string,
		public readonly pouch: PouchService,
		/** 이 링크 root 아래에 중첩된 다른 링크들의 root(공유 폴더 등). 동기화에서 제외해 이중 동기화 방지. */
		public readonly childRoots: string[] = [],
	) {}

	get app() {
		return this.core.app;
	}
	get settings() {
		return this.core.settings;
	}
	get logger() {
		return this.core.logger;
	}
	get guard() {
		return this.core.guard;
	}

	/**
	 * 이 동기화가 '구성원의 읽기전용 공유 공간'인가. 구성원이고 sharedReadOnly이며 개인 mirror가
	 * 아닌(공유 공간) DB면 true. 서버 validate가 비참여자 쓰기(편집·삭제)를 거부하는 것과 짝 —
	 * 클라이언트에서 삭제 echo를 tombstone 대신 복원으로 처리하는 데 쓴다(파일별 참여자는 별도 확인).
	 */
	get isReadOnlyShared(): boolean {
		const s = this.settings;
		return s.role === "member" && !!s.sharedReadOnly && this.remoteDb !== s.remoteDb;
	}

	// --- 경로 매핑 (기술문서 §9) ---

	/** DB path → 로컬 vault 경로(정규화). */
	toLocalPath(dbPath: string): string {
		return obsidianNormalize(dbPathToLocal(this.localRoot, dbPath));
	}

	/** 로컬 vault 경로 → DB path. localRoot 밖이면 null(§9.4). */
	toDbPath(localPath: string): string | null {
		return localPathToDb(this.localRoot, localPath);
	}

	isMarkdown(path: string): boolean {
		return path.toLowerCase().endsWith(".md");
	}

	/** excludeFolders 또는 보관 폴더 아래 경로인지(로컬 경로 기준). 보관 폴더는 note로 동기화하지 않는다. */
	isExcluded(localPath: string): boolean {
		const p = normalizePath(localPath);
		const archiveRoot = normalizePath(dbPathToLocal(this.localRoot, this.settings.archiveFolder));
		if (archiveRoot !== "" && (p === archiveRoot || p.startsWith(archiveRoot + "/"))) return true;
		const conflictRoot = normalizePath(dbPathToLocal(this.localRoot, this.settings.conflictFolder));
		if (conflictRoot !== "" && (p === conflictRoot || p.startsWith(conflictRoot + "/"))) return true;
		// 다른 링크(공유 폴더 등)가 담당하는 하위 경로는 이 링크에서 제외
		for (const child of this.childRoots) {
			const cr = normalizePath(child);
			if (cr !== "" && (p === cr || p.startsWith(cr + "/"))) return true;
		}
		return this.settings.excludeFolders.some((f) => {
			const folder = normalizePath(f);
			return folder !== "" && (p === folder || p.startsWith(folder + "/"));
		});
	}

	// --- 로컬 changes 체크포인트 (settings에 영속) ---

	getLastSeq(): string | undefined {
		return this.settings.lastSeqByDb[this.remoteDb];
	}
	setLastSeq(seq: string): void {
		this.settings.lastSeqByDb[this.remoteDb] = seq;
		this.core.requestPersist();
	}

	/**
	 * 이벤트 구동 동기화(통합 변경 감지)에서 로컬 DB 쓰기 후 원격 push를 깨우는 훅(MirrorSync가 주입).
	 * live replication 모드에선 undefined — live sync가 자동 전파하므로 불필요.
	 */
	notifyLocalWrite?: () => void;

	// --- 업로드 대기 중인 로컬 경로 (적용 레이스 방지) ---
	// 사용자가 방금 편집해 업로드 대기 중인 파일은 원격 적용으로 덮지 않는다.
	// 참조 카운트: 업로드 의무(디바운스 타이머 1개 또는 진행 중 업로드 1건)마다 1씩 잡는다.
	// 단순 Set이면 편집1의 업로드 완료가 편집2의 대기 표식까지 지워, 그 틈에 도착한 원격 갱신이
	// 아직 업로드되지 않은 편집2를 보존 없이 덮을 수 있다.
	private pending = new Map<string, number>();

	markPending(dbPath: string): void {
		this.pending.set(dbPath, (this.pending.get(dbPath) ?? 0) + 1);
	}
	clearPending(dbPath: string): void {
		const n = this.pending.get(dbPath) ?? 0;
		if (n <= 1) this.pending.delete(dbPath);
		else this.pending.set(dbPath, n - 1);
	}
	isPending(dbPath: string): boolean {
		return this.pending.has(dbPath);
	}

	// --- 구조적 변경(이동/삭제) echo 차단 ---
	// applier가 archive(파일 이동)/삭제할 때 발생하는 rename/delete 이벤트를 무시하기 위한 경로 표식.
	// 해시 기반 guard로는 삭제/이동을 못 거르므로 경로 기반 표식을 따로 둔다.
	private suppressed = new Map<string, ReturnType<typeof setTimeout>>();

	suppressStructural(localPath: string, ms = 5000): void {
		const prev = this.suppressed.get(localPath);
		if (prev) clearTimeout(prev);
		this.suppressed.set(
			localPath,
			setTimeout(() => this.suppressed.delete(localPath), ms),
		);
	}
	isStructuralSuppressed(localPath: string): boolean {
		return this.suppressed.has(localPath);
	}

	/** archive 대상 경로: localRoot/<archiveFolder>/<dbPath>. 기술문서 §10.4 / §15.1. */
	archiveLocalPath(dbPath: string): string {
		return obsidianNormalize(dbPathToLocal(this.localRoot, `${this.settings.archiveFolder}/${dbPath}`));
	}

	/**
	 * 충돌 원격본 경로: localRoot/<conflictFolder>/<dbPath의 .md 앞에 .<상대방>>. 결정적 이름.
	 * 교사 vault에서 여러 학생 충돌을 구분할 수 있도록 상대방(학생 이름/교사)을 파일명에 넣는다.
	 */
	conflictLocalPath(dbPath: string): string {
		const tagged = insertLabelBeforeExt(dbPath, sanitizeFileLabel(this.conflictPeerLabel()));
		return obsidianNormalize(dbPathToLocal(this.localRoot, `${this.settings.conflictFolder}/${tagged}`));
	}

	/** 충돌 원격본의 상대방 라벨: 교사 입장=학생 이름, 학생 입장=교사. */
	conflictPeerLabel(): string {
		if (this.settings.role === "manager") return this.memberName || this.memberId || t("common.member");
		return t("common.manager");
	}

	/** 내 편집 백업 경로: 상대가 충돌을 해소해 내 편집이 덮일 때 보존. _충돌/<base>.내편집.md */
	localBackupPath(dbPath: string): string {
		const tagged = insertLabelBeforeExt(dbPath, sanitizeFileLabel(t("common.myedit")));
		return obsidianNormalize(dbPathToLocal(this.localRoot, `${this.settings.conflictFolder}/${tagged}`));
	}

	/**
	 * 보관 폴더 안의 로컬 경로 → 원래 dbPath(역매핑). 보관 폴더 밖이면 null.
	 * 사용자가 보관 폴더에서 파일을 지우면 해당 dbPath의 DB 문서를 purge하기 위함.
	 */
	archiveDbPath(localPath: string): string | null {
		const root = normalizePath(dbPathToLocal(this.localRoot, this.settings.archiveFolder));
		const p = normalizePath(localPath);
		if (p === root) return null;
		if (p.startsWith(root + "/")) return p.slice(root.length + 1);
		return null;
	}

	/** 파일 이동(이름변경). 부모 폴더 보장 후 vault.rename. */
	async renameVaultFile(file: TFile, toLocalPath: string): Promise<void> {
		await this.ensureFolderFor(toLocalPath);
		await this.app.fileManager.renameFile(file, toLocalPath);
	}

	async deleteVaultFile(file: TFile): Promise<void> {
		await this.app.vault.trash(file, false); // 시스템 휴지통이 아닌 vault 내 .trash
	}

	getFile(localPath: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(localPath);
		return f instanceof TFile ? f : null;
	}

	/**
	 * 대소문자만 다른 기존 파일 경로(없으면 null). 케이스 무시 FS(macOS/Windows)에선 이런 경로에
	 * vault.create가 "already exists"로 실패해 적용이 영구 정지(stall)된다 — 생성 전에 감지해 비켜간다.
	 * 정확 일치가 이미 있으면 충돌이 아니다. (파일 생성 경로에서만 호출 — 전체 스캔 비용 주의.)
	 */
	findCaseCollision(localPath: string): string | null {
		if (this.fileExists(localPath)) return null;
		const lower = normalizePath(localPath).toLowerCase();
		for (const f of this.app.vault.getFiles()) {
			if (f.path.toLowerCase() === lower) return f.path;
		}
		return null;
	}

	fileExists(localPath: string): boolean {
		return this.app.vault.getAbstractFileByPath(localPath) != null;
	}

	private async ensureFolderFor(localPath: string): Promise<void> {
		await this.ensureParentFolder(localPath);
	}

	// --- vault 입출력 ---

	async readVaultFile(localPath: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(localPath);
		if (file instanceof TFile) return await this.app.vault.read(file);
		return null;
	}

	async writeVaultFile(localPath: string, content: string): Promise<void> {
		await this.ensureParentFolder(localPath);
		const existing = this.app.vault.getAbstractFileByPath(localPath);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, () => content); // 백그라운드 쓰기: 가이드라인 권장(atomic)
		} else {
			await this.app.vault.create(localPath, content);
		}
	}

	/**
	 * compare-and-swap 쓰기(평가 D-2). 호출측이 읽은 시점의 내용(expected)과 디스크가 같을 때만 덮는다.
	 * applier의 읽기→쓰기 사이 ms 창에 사용자 편집이 끼어들면(아직 watcher pending으로 안 잡힌 저장)
	 * 보존 없이 덮여 사라질 수 있었다 — process 콜백 안에서 재확인해 다르면 변경하지 않고 false를
	 * 반환한다(다음 change/전체 동기화가 pending 보존 규칙으로 재평가). expected=null은 "파일 없음"
	 * 기대(생성) — 그 사이 생겼거나, 있다고 기대했는데 사라졌으면 중단한다.
	 */
	async writeVaultFileIf(localPath: string, expected: string | null, content: string): Promise<boolean> {
		await this.ensureParentFolder(localPath);
		const existing = this.app.vault.getAbstractFileByPath(localPath);
		if (existing instanceof TFile) {
			if (expected == null) return false; // 기대: 없음 — 읽기 이후 생성됨
			let applied = false;
			await this.app.vault.process(existing, (data) => {
				if (data !== expected) return data; // 끼어든 편집 — 그대로 둔다
				applied = true;
				return content;
			});
			return applied;
		}
		if (expected != null) return false; // 기대: 있음 — 읽기 이후 삭제됨
		await this.app.vault.create(localPath, content);
		return true;
	}

	private async ensureParentFolder(localPath: string): Promise<void> {
		// 누락된 모든 조상 폴더를 재귀로 생성한다(깊은 경로 a/b/c.md 안전).
		await ensureParentFolders(this.app, localPath);
	}

	// --- 바이너리(첨부파일) 입출력 ---

	async readVaultBinary(localPath: string): Promise<ArrayBuffer | null> {
		const file = this.app.vault.getAbstractFileByPath(localPath);
		if (file instanceof TFile) return await this.app.vault.readBinary(file);
		return null;
	}

	async writeVaultBinary(localPath: string, data: ArrayBuffer): Promise<void> {
		await this.ensureParentFolder(localPath);
		const existing = this.app.vault.getAbstractFileByPath(localPath);
		if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data);
		else await this.app.vault.createBinary(localPath, data);
	}

	/**
	 * writeVaultFileIf의 바이너리 CAS 변형(평가 P2-4 — 노트 D-2와 대칭). 읽기 시점 해시(expectedHash)와
	 * 현재 디스크 해시가 일치할 때만 덮는다 — 읽기 이후 끼어든 로컬 편집을 보존 없이 덮지 않는다. 적용했으면 true.
	 */
	async writeVaultBinaryIf(localPath: string, expectedHash: string | null, data: ArrayBuffer): Promise<boolean> {
		await this.ensureParentFolder(localPath);
		const existing = this.app.vault.getAbstractFileByPath(localPath);
		if (existing instanceof TFile) {
			if (expectedHash == null) return false; // 기대: 없음 — 읽기 이후 생성됨
			const cur = await this.app.vault.readBinary(existing);
			if ((await sha256(cur)) !== expectedHash) return false; // 끼어든 편집 — 그대로 둔다
			await this.app.vault.modifyBinary(existing, data);
			return true;
		}
		if (expectedHash != null) return false; // 기대: 있음 — 읽기 이후 삭제됨
		await this.app.vault.createBinary(localPath, data);
		return true;
	}

	// --- 문서 빌드 ---

	/** 로컬 내용으로 NoteDoc 빌드(업로드용). 기술문서 §8.1. */
	async buildNoteDoc(dbPath: string, content: string, prevVersion = 0): Promise<NoteDoc> {
		const s = this.settings;
		const now = Date.now();
		return {
			_id: `note:${dbPath}`,
			type: "note",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			memberId: this.memberId,
			path: dbPath,
			content,
			contentHash: await sha256(content),
			mtime: now,
			deleted: false,
			version: prevVersion + 1,
			lastModifiedBy: s.userId,
			lastModifiedRole: s.role,
			lastModifiedDeviceId: s.deviceId,
			updatedAt: new Date(now).toISOString(),
		};
	}

	/** asset(첨부파일) 문서 빌드. 바이너리는 PouchService가 attachment로 저장. 기술문서 §8.2. */
	async buildAssetDoc(dbPath: string, data: ArrayBuffer, prevVersion = 0): Promise<AssetDoc> {
		const s = this.settings;
		const now = Date.now();
		return {
			_id: assetId(dbPath),
			type: "asset",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			memberId: this.memberId,
			path: dbPath,
			mime: mimeFor(dbPath),
			size: data.byteLength,
			contentHash: await sha256(data),
			mtime: now,
			deleted: false,
			version: prevVersion + 1,
			lastModifiedBy: s.userId,
			lastModifiedRole: s.role,
			lastModifiedDeviceId: s.deviceId,
			updatedAt: new Date(now).toISOString(),
		};
	}

	/** DB path 유효성(§9.1). */
	isValidDbPath(dbPath: string): boolean {
		return validateVaultPath(dbPath);
	}
}

/** 확장자 → MIME. 미상은 octet-stream. */
function mimeFor(path: string): string {
	const ext = (path.split(".").pop() ?? "").toLowerCase();
	const map: Record<string, string> = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		svg: "image/svg+xml",
		bmp: "image/bmp",
		pdf: "application/pdf",
		mp3: "audio/mpeg",
		mp4: "video/mp4",
		webm: "video/webm",
		zip: "application/zip",
		json: "application/json",
		txt: "text/plain",
		csv: "text/csv",
	};
	return map[ext] ?? "application/octet-stream";
}
