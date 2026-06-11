import { EventRef, Platform, TAbstractFile, TFile } from "obsidian";
import { errMessage } from "../util/err";
import { MirrorContext } from "./MirrorContext";
import { Uploader } from "./Uploader";
import { exceedsAttachmentLimit } from "./attachment";
import { sha256 } from "../hash/hash";
import { t } from "../../i18n";

/**
 * vault 변경 감지 → debounce → 업로드. 기술문서 §11.2 / §11.3.
 *
 * ⚠️ 시작 시점이 중요하다: Obsidian은 앱 시작 시 기존 전 파일에 'create'를 한 번씩 발생시킨다.
 * 따라서 workspace.onLayoutReady() 이후에만 이벤트를 등록해 시작 시 전체 재업로드를 막는다.
 * create/modify(업로드) + rename/delete(tombstone)를 모두 다룬다.
 */
export class LocalWatcher {
	private refs: EventRef[] = [];
	/** 경로별 디바운스 타이머. 각 타이머는 pending 카운트 1을 보유한다(flushUpload 완료 시 해제). */
	private timers = new Map<string, { timer: ReturnType<typeof setTimeout>; dbPath: string }>();
	private started = false;

	constructor(
		private ctx: MirrorContext,
		private uploader: Uploader,
	) {}

	start(): void {
		if (this.started) return;
		this.started = true;
		// 시작 create 폭주 회피: layout-ready 이후 등록
		this.ctx.app.workspace.onLayoutReady(() => {
			if (!this.started) return; // 등록 전에 stop된 경우
			const vault = this.ctx.app.vault;
			this.refs.push(vault.on("create", (f) => this.onChange(f)));
			this.refs.push(vault.on("modify", (f) => this.onChange(f)));
			this.refs.push(vault.on("rename", (f, oldPath) => this.onRename(f, oldPath)));
			this.refs.push(vault.on("delete", (f) => this.onDelete(f)));
			this.ctx.logger.info(
				t("sync.localwatcher_started_localroot", { root: this.ctx.localRoot || t("sync.vault_root") }),
			);
		});
	}

	stop(): void {
		this.started = false;
		for (const ref of this.refs) this.ctx.app.vault.offref(ref);
		this.refs = [];
		for (const entry of this.timers.values()) {
			clearTimeout(entry.timer);
			this.ctx.clearPending(entry.dbPath); // 타이머가 보유한 pending 카운트 반환
		}
		this.timers.clear();
	}

	private onChange(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const localPath = file.path;

		// 빠른 1차 필터(md/asset 공통, 상세 필터는 Uploader가 재확인)
		if (this.ctx.isExcluded(localPath)) return;
		const dbPath = this.ctx.toDbPath(localPath);
		if (dbPath == null) return; // localRoot 밖

		void this.maybeSchedule(localPath, dbPath);
	}

	/**
	 * 원격 적용(applier)으로 인한 echo면 guard로 걸러 아예 무시한다(pending도 잡지 않음).
	 * 진짜 사용자 편집만 pending 표시 + 업로드 예약 → 디바운스 동안 원격 적용이 덮지 못하게.
	 */
	private async maybeSchedule(localPath: string, dbPath: string): Promise<void> {
		// 실시간 세션 중인 파일은 Yjs가 권위 → CouchDB 업로드하지 않음(Obsidian 자동저장 포함).
		// 세션 종료 시 스냅샷만 업로드된다.
		if (this.ctx.core.isRealtimeActive(localPath)) return;

		const hash = await this.currentHash(localPath);
		if (hash == null) return;
		if (this.ctx.guard.shouldIgnore(localPath, hash)) return; // applier echo → 무시 (§16.2)

		this.ctx.markPending(dbPath);
		this.scheduleUpload(localPath, dbPath);
	}

	/** 현재 파일 콘텐츠 해시(markdown=텍스트, 그 외=바이너리). */
	private async currentHash(localPath: string): Promise<string | null> {
		if (this.ctx.isMarkdown(localPath)) {
			const c = await this.ctx.readVaultFile(localPath);
			return c == null ? null : await sha256(c);
		}
		// 큰 첨부는 메모리에 읽기 전에 크기 한도를 본다(업로드와 동일 — 모바일 보호). 초과면 추적/업로드 대상 아님.
		const size = this.ctx.getFile(localPath)?.stat.size ?? 0;
		if (exceedsAttachmentLimit(size, this.ctx.settings.maxAttachmentMB || 0)) return null;
		const b = await this.ctx.readVaultBinary(localPath);
		return b == null ? null : await sha256(b);
	}

	/**
	 * 이름변경/이동. 기술문서 §10.3: 옛 경로 tombstone + 새 경로 생성.
	 * applier가 archive로 일으킨 이동은 suppress로 걸러진다.
	 */
	private onRename(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile)) return; // 폴더 이름변경은 범위 밖
		const newPath = file.path;
		if (this.ctx.isStructuralSuppressed(oldPath) || this.ctx.isStructuralSuppressed(newPath)) return;
		void this.handleRename(oldPath, newPath);
	}

	private async handleRename(oldPath: string, newPath: string): Promise<void> {
		try {
			// 옛 경로가 동기화 범위 안이면 tombstone(md/asset 공통)
			const oldDb = this.ctx.toDbPath(oldPath);
			if (oldDb != null && !this.ctx.isExcluded(oldPath)) {
				await this.uploader.tombstonePath(oldDb);
			}
			// 새 경로가 범위 안이면 업로드(md/asset 공통)
			const newDb = this.ctx.toDbPath(newPath);
			if (newDb != null && !this.ctx.isExcluded(newPath)) {
				this.ctx.markPending(newDb);
				try {
					await this.uploader.uploadPath(newPath);
				} finally {
					this.ctx.clearPending(newDb);
				}
			}
		} catch (e) {
			this.ctx.logger.error(
				t("sync.rename_handling_failed", {
					from: oldPath,
					to: newPath,
					err: errMessage(e),
				}),
			);
		}
	}

	/**
	 * 삭제.
	 *  - .deleted/ 안의 파일을 지우면 → DB 문서 영구 제거(purge). 아카이브가 무한히 쌓이지 않게.
	 *  - 일반 파일 삭제 → tombstone(상대 vault는 정책대로 처리, 기술문서 §10.4).
	 */
	private onDelete(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const localPath = file.path;
		if (this.ctx.isStructuralSuppressed(localPath)) return; // applier가 일으킨 삭제/이동 echo

		// .deleted/ 안에서 삭제 → purge
		const archivedDb = this.ctx.archiveDbPath(localPath);
		if (archivedDb != null) {
			void this.uploader
				.purgePath(archivedDb)
				.catch((e) =>
					this.ctx.logger.error(
						t("sync.purge_failed", { path: localPath, err: errMessage(e) }),
					),
				);
			return;
		}

		// 일반 삭제 → tombstone
		if (this.ctx.isExcluded(localPath)) return;
		const dbPath = this.ctx.toDbPath(localPath);
		if (dbPath == null) return;
		void this.uploader
			.tombstonePath(dbPath)
			.catch((e) =>
				this.ctx.logger.error(
					t("sync.delete_handling_failed", { path: localPath, err: errMessage(e) }),
				),
			);
	}

	private scheduleUpload(localPath: string, dbPath: string): void {
		const existing = this.timers.get(localPath);
		if (existing) {
			clearTimeout(existing.timer);
			// 교체된 타이머의 flush는 실행되지 않는다 — 그 타이머가 보유한 pending 카운트를 반환해
			// 호출자(maybeSchedule)가 새로 잡은 카운트와 합쳐 정확히 1만 남게 한다.
			this.ctx.clearPending(existing.dbPath);
		}
		// 모바일은 배터리/네트워크 절감을 위해 더 긴 디바운스 사용(기술문서 §24.6).
		const delay = Platform.isMobile ? this.ctx.settings.mobileDebounceMs : this.ctx.settings.debounceMs;
		const timer = setTimeout(() => {
			this.timers.delete(localPath);
			void this.flushUpload(localPath, dbPath);
		}, delay);
		this.timers.set(localPath, { timer, dbPath });
	}

	private async flushUpload(localPath: string, dbPath: string): Promise<void> {
		try {
			await this.uploader.uploadPath(localPath);
		} catch (e) {
			this.ctx.logger.error(
				t("sync.upload_failed", { path: localPath, err: errMessage(e) }),
			);
		} finally {
			this.ctx.clearPending(dbPath);
		}
	}
}
