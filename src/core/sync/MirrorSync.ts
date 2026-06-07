import { CoreServices } from "../CoreServices";
import { errMessage } from "../util/err";
import { PouchService, ReplicationHandlers } from "../couch/PouchService";
import { MirrorContext } from "./MirrorContext";
import { MirrorApplier } from "./MirrorApplier";
import { ConflictManager, ConflictInfo, ResolveChoice } from "./ConflictManager";
import { RestoreManager, DeletedItem, RestoreResult, RestoreOptions, DeleteModifyChoice } from "./RestoreManager";
import { PurgeSnapshot } from "./recentPurge";
import { DeleteModifyItem } from "./deleteModifyQueue";
import { VersionDoc } from "../model/types";
import { Uploader, UploadResult } from "./Uploader";
import { LocalWatcher } from "./LocalWatcher";
import { LocalApplier } from "./LocalApplier";
import { FullSync, SyncDirection } from "./FullSync";
import { t } from "../../i18n";

/**
 * 하나의 member↔mirror 링크 동기화 엔진. 기술문서 §23.3.
 *
 * 오프라인 우선 구조:
 *  - PouchDB live replication(retry)으로 로컬 DB ↔ 원격을 자동 동기화(오프라인 큐·재연결·충돌).
 *  - LocalApplier: 로컬 DB 변경 → vault 반영
 *  - LocalWatcher: vault 변경 → 로컬 DB 기록(replication이 원격 전파)
 *
 * 실행 동작:
 *  - 최초: 기존 vault 파일을 로컬 DB로 1회 업로드 스캔(원격 문서는 replication이 자동으로 가져와 반영)
 *  - 이후: 저장된 local seq부터 증분 적용 + 상시 replication
 */
export interface MirrorSyncOptions {
	memberId: string;
	memberName: string;
	localRoot: string;
	remoteDb: string;
	childRoots?: string[];
	pouch?: PouchService;
	/** 'shares' 등 설정 문서가 바뀌면 호출(학생이 공유 링크 reconcile). */
	onConfigChange?: () => void;
}

export class MirrorSync {
	readonly ctx: MirrorContext;
	private readonly applier: MirrorApplier;
	private readonly conflicts: ConflictManager;
	private readonly restorer: RestoreManager;
	private readonly uploader: Uploader;
	private readonly watcher: LocalWatcher;
	private readonly localApplier: LocalApplier;
	private readonly fullSyncRunner: FullSync;
	private started = false;
	private pausedByHidden = false; // 백그라운드 일시정지로 replication을 멈춘 상태

	constructor(core: CoreServices, opts: MirrorSyncOptions) {
		const remoteDb = opts.remoteDb;
		this.ctx = new MirrorContext(
			core,
			opts.memberId,
			opts.memberName,
			opts.localRoot,
			remoteDb,
			opts.pouch ?? core.createPouch(remoteDb),
			opts.childRoots ?? [],
		);
		this.conflicts = new ConflictManager(this.ctx);
		this.applier = new MirrorApplier(this.ctx, this.conflicts);
		this.uploader = new Uploader(this.ctx);
		this.restorer = new RestoreManager(this.ctx, this.uploader);
		this.watcher = new LocalWatcher(this.ctx, this.uploader);
		this.localApplier = new LocalApplier(this.ctx, this.applier, opts.onConfigChange);
		this.fullSyncRunner = new FullSync(this.ctx, this.applier, this.uploader);
	}

	/** 이 링크의 라벨(학생 식별). */
	get label(): string {
		return this.ctx.memberId || this.ctx.remoteDb;
	}

	// 대시보드용 정보 노출
	get memberId(): string {
		return this.ctx.memberId;
	}
	get memberName(): string {
		return this.ctx.memberName;
	}
	get remoteDb(): string {
		return this.ctx.remoteDb;
	}
	get localRoot(): string {
		return this.ctx.localRoot;
	}
	get status() {
		return this.ctx.status;
	}

	listConflicts(): Promise<ConflictInfo[]> {
		return this.conflicts.list();
	}

	resolveConflict(dbPath: string, choice: ResolveChoice): Promise<void> {
		return this.conflicts.resolve(dbPath, choice);
	}

	// --- 삭제 파일 복구 (보고서 §2 P1) ---
	listDeleted(): Promise<DeletedItem[]> {
		return this.restorer.listDeleted();
	}
	restoreDeleted(dbPath: string, opts?: RestoreOptions): Promise<RestoreResult> {
		return this.restorer.restore(dbPath, opts);
	}
	purgeDeleted(dbPath: string): Promise<"purged" | "skipped"> {
		return this.restorer.purge(dbPath);
	}

	// --- 최근 영구 삭제 되돌리기 / 삭제·수정 충돌 큐 (보고서 §2 P2) ---
	listRecentPurges(): Promise<PurgeSnapshot[]> {
		return this.restorer.listRecentPurges();
	}
	undoPurge(id: string): Promise<RestoreResult> {
		return this.restorer.undoPurge(id);
	}
	clearPurge(id: string): Promise<void> {
		return this.restorer.clearPurgeEntry(id);
	}
	listDeleteModify(): Promise<DeleteModifyItem[]> {
		return this.restorer.listDeleteModify();
	}
	resolveDeleteModify(dbPath: string, choice: DeleteModifyChoice): Promise<void> {
		return this.restorer.resolveDeleteModify(dbPath, choice);
	}

	// --- 버전 히스토리 (보고서 §1 P1) ---
	listVersions(dbPath: string): Promise<VersionDoc[]> {
		return this.ctx.versions.list(dbPath);
	}
	restoreVersion(versionDocId: string, opts: { backupCurrent?: boolean }): Promise<"restored" | "missing"> {
		return this.ctx.versions.restoreVersion(versionDocId, opts);
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		if (!this.ctx.settings.autoSync) {
			this.ctx.status.state = "disabled";
			this.ctx.logger.info(t("sync.autosync_off_automatic_sync_disabled_manual"));
			return;
		}
		if (!this.ctx.settings.couchdbUrl) {
			this.ctx.status.state = "offline";
			this.ctx.logger.warn(t("sync.no_couchdb_url_enter_it_in"), true);
			return;
		}
		this.ctx.status.state = "syncing";

		// 실시간 동기화를 켜기 전에 시작 정합을 수행한다(기술문서 §17.2).
		// 미반영 로컬 편집을 먼저 올리되, 삭제 정합은 pull 이후에만 해서 다른 기기의 원격 수정을
		// stale tombstone으로 밀지 않는다(run("up")의 조기 tombstone 문제 회피).
		try {
			await this.fullSyncRunner.runStartup();
		} catch (e) {
			this.ctx.logger.error(
				t("sync.upload_reconciliation_on_startup_failed", { err: errMessage(e) }),
				true,
			);
		}

		// 로컬 DB 변경을 vault에 반영(원격에서 replication으로 들어온 것 포함)
		this.localApplier.start();
		// 로컬 ↔ 원격 live replication (오프라인 큐·재연결·충돌)
		this.ctx.pouch.startReplication(this.replicationHandlers());
		// vault 변경 감시
		this.watcher.start();
	}

	/** live replication 핸들러(시작/재개 공용). */
	private replicationHandlers(): ReplicationHandlers {
		return {
			onActive: () => {
				this.ctx.status.state = "syncing";
			},
			onPaused: (err) => {
				if (this.ctx.status.state === "error") return;
				// 오류(예: 삭제된 DB·오프라인)면 offline, 아니면 idle. 상태가 바뀔 때만 로그(스팸 방지).
				const next = err ? "offline" : "idle";
				if (this.ctx.status.state === next) return;
				this.ctx.status.state = next;
				this.ctx.logger.info(
					err
						? t("sync.sync_waiting_offline_error", { db: this.ctx.remoteDb })
						: t("sync.sync_caught_up_idle", { db: this.ctx.remoteDb }),
				);
			},
			onError: (e) => {
				this.ctx.status.lastError = e.message;
				this.ctx.status.state = "error";
				// 인증 실패면 재시도를 멈춘다(계속 두드리면 서버가 계정을 잠금).
				if (isAuthError(e.message)) {
					this.ctx.pouch.stopReplication();
					this.ctx.logger.error(
						t("sync.sync_stopped_due_to_auth_failure", {
							db: this.ctx.remoteDb,
							err: e.message,
						}),
						true,
					);
				} else {
					this.ctx.logger.error(t("sync.replication_error", { err: e.message }));
				}
			},
		};
	}

	/** 백그라운드 진입 시 원격 replication만 일시정지(배터리/네트워크 절감). watcher/applier는 유지. */
	pauseReplication(): void {
		if (!this.started || this.pausedByHidden) return;
		if (this.ctx.status.state === "disabled" || this.ctx.status.state === "error") return;
		this.pausedByHidden = true;
		this.ctx.pouch.stopReplication();
		this.ctx.status.state = "offline";
		this.ctx.logger.info(t("sync.background_sync_paused", { db: this.ctx.remoteDb }));
	}

	/** 포그라운드 복귀 시 replication 재개(내가 일시정지했던 경우만). */
	resumeReplication(): void {
		if (!this.pausedByHidden) return;
		this.pausedByHidden = false;
		if (!this.started || !this.ctx.settings.autoSync || !this.ctx.settings.couchdbUrl) return;
		this.ctx.status.state = "syncing";
		this.ctx.pouch.startReplication(this.replicationHandlers());
		this.ctx.logger.info(t("sync.foreground_sync_resumed", { db: this.ctx.remoteDb }));
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.ctx.status.state = "disabled";
		this.watcher.stop();
		this.localApplier.stop();
		await this.ctx.core.flushPersist();
		await this.ctx.pouch.close();
	}

	fullSync(direction: SyncDirection = "both"): Promise<void> {
		return this.fullSyncRunner.run(direction);
	}

	/** 실시간 스냅샷: Yjs 내용을 vault 미접촉으로 로컬 DB에 기록(→ replication이 원격 전파). 기술문서 §19.2. */
	snapshotNote(localPath: string, content: string): Promise<UploadResult> {
		return this.uploader.uploadContent(localPath, content);
	}

	/** 피드백 라우팅용: 이 링크가 해당 로컬 경로를 담당하는가(localRoot 안 + 제외 아님). */
	owns(localPath: string): boolean {
		const dbPath = this.ctx.toDbPath(localPath);
		return dbPath != null && !this.ctx.isExcluded(localPath);
	}
}

/** 인증/계정잠금 류 오류 판별(재시도 폭주 방지). */
function isAuthError(message: string): boolean {
	return /unauthorized|name or password|password is incorrect|forbidden|locked|\b401\b|\b403\b/i.test(message);
}
