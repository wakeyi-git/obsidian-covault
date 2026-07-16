import { EventRef, Platform, TAbstractFile, TFile, TFolder } from "obsidian";
import { errMessage, isDbClosingError } from "../util/err";
import { MirrorContext } from "./MirrorContext";
import { Uploader } from "./Uploader";
import { exceedsAttachmentLimit } from "./attachment";
import { sha256 } from "../hash/hash";
import { NoteDoc, AssetDoc, noteId, assetId } from "../model/types";
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
	/** 읽기전용 원복 진행 중인 경로(재진입·오토세이브 루프 방지). 잠깐 잠갔다 푼다. */
	private reverting = new Set<string>();
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

	/**
	 * 동기화 쓰기 실패 로깅. 비활성화/리로드 중 로컬 DB가 닫혀 난 종료 레이스(isDbClosingError)는 실제
	 * 실패가 아니라 다음 시작의 reconcileDeletions로 치유되므로 info로 강등한다 — 진짜 실패만 error로 남긴다.
	 */
	private logWriteFailure(path: string, e: unknown, normal: string): void {
		if (isDbClosingError(e)) this.ctx.logger.info(t("sync.write_skipped_db_closing", { path }));
		else this.ctx.logger.error(normal);
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

		// 해시 계산은 guard 표시가 살아 있는(=방금 applier가 쓴) 경로에서만 — echo 판별에만 필요하다
		// (평가 P-3). 폴더 이동·git checkout 같은 대량 사용자 이벤트는 guard 미표시라, 이벤트마다
		// 즉시 파일 읽기+해시가 무제한 동시 실행되던 폭주가 사라진다(실제 해시·업로드는 디바운스 후
		// flushUpload가 동시성 한도 안에서 수행).
		if (this.ctx.guard.isMarked(localPath)) {
			const hash = await this.currentHash(localPath);
			if (hash == null) return;
			if (this.ctx.guard.shouldIgnore(localPath, hash)) return; // applier echo → 무시 (§16.2)
		}

		// 읽기전용 공유 공간: 구성원의 직접 편집/생성은 올리지 않고 정본으로 되돌린다(편집은 실시간 세션으로만).
		// "변경 내용이 기기에 보관"되지 않고 변경 전으로 복원된다.
		if (this.ctx.isReadOnlyShared) {
			await this.reconcileReadOnly(dbPath, localPath);
			return;
		}

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
		const newPath = file.path;
		if (this.ctx.isStructuralSuppressed(oldPath) || this.ctx.isStructuralSuppressed(newPath)) return;
		if (file instanceof TFolder) {
			this.cancelScheduledUnder(oldPath);
			void this.handleFolderRename(oldPath, newPath).catch((e) =>
				this.logWriteFailure(
					newPath,
					e,
					t("sync.rename_handling_failed", { from: oldPath, to: newPath, err: errMessage(e) }),
				),
			);
			return;
		}
		if (!(file instanceof TFile)) return;
		void this.handleRename(oldPath, newPath);
	}

	/** 폴더 이동 전에 예약된 옛 파일 업로드를 취소하고 pending 참조 카운트를 반환한다. */
	private cancelScheduledUnder(folderPath: string): void {
		const prefix = folderPath.replace(/\/+$/, "") + "/";
		for (const [localPath, entry] of [...this.timers]) {
			if (!localPath.startsWith(prefix)) continue;
			clearTimeout(entry.timer);
			this.ctx.clearPending(entry.dbPath);
			this.timers.delete(localPath);
		}
	}

	/**
	 * 폴더 이름변경/이동: 옛 prefix의 라이브 문서는 모두 tombstone하고, 새 폴더 아래 실제 파일을 다시
	 * 업로드한다. Obsidian이 내부 파일별 rename 이벤트를 내지 않는 플랫폼에서도 전체 하위 트리가 수렴한다.
	 * 읽기전용 공유 공간은 폴더 자체를 원래 경로로 되돌려 사용자 변경을 원자적으로 취소한다.
	 */
	private async handleFolderRename(oldFolderPath: string, newFolderPath: string): Promise<void> {
		if (this.ctx.isReadOnlyShared) {
			const folder = this.ctx.app.vault.getAbstractFileByPath(newFolderPath);
			if (folder instanceof TFolder) {
				this.ctx.suppressStructural(oldFolderPath);
				this.ctx.suppressStructural(newFolderPath);
				await this.ctx.app.fileManager.renameFile(folder, oldFolderPath);
				const displayPath = this.ctx.toDbPath(oldFolderPath) ?? this.ctx.toDbPath(newFolderPath) ?? oldFolderPath;
				this.ctx.logger.warn(t("sync.readonly_change_reverted", { path: displayPath }), true);
			}
			return;
		}

		const oldFolderDb = this.ctx.toDbPath(oldFolderPath);
		if (oldFolderDb != null && oldFolderDb !== "" && !this.ctx.isExcluded(oldFolderPath)) {
			const prefix = oldFolderDb.replace(/\/+$/, "") + "/";
			const notes = await this.ctx.pouch.allDocsByPrefix<NoteDoc>(noteId(prefix));
			const assets = await this.ctx.pouch.allDocsByPrefix<AssetDoc>(assetId(prefix));
			for (const doc of [...notes, ...assets]) {
				if (!doc.deleted) await this.uploader.tombstonePath(doc.path);
			}
		}

		const prefix = newFolderPath.replace(/\/+$/, "") + "/";
		const files = this.ctx.app.vault.getFiles().filter((file) => file.path.startsWith(prefix));
		await Promise.all(
			files.map(async (file) => {
				const dbPath = this.ctx.toDbPath(file.path);
				if (dbPath == null || this.ctx.isExcluded(file.path)) return;
				this.ctx.markPending(dbPath);
				try {
					await this.withUploadSlot(() => this.uploader.uploadPath(file.path));
				} finally {
					this.ctx.clearPending(dbPath);
				}
			}),
		);
	}

	private async handleRename(oldPath: string, newPath: string): Promise<void> {
		try {
			// 읽기전용 공유 공간: 구성원은 이름변경도 할 수 없다 — 옛 경로를 정본으로 복원하고
			// 새(잘못 생긴) 경로는 정본이 없으니 vault에서 제거한다(이름변경 취소).
			if (this.ctx.isReadOnlyShared) {
				const oldDbRo = this.ctx.toDbPath(oldPath);
				if (oldDbRo != null && !this.ctx.isExcluded(oldPath)) await this.reconcileReadOnly(oldDbRo, oldPath);
				const newDbRo = this.ctx.toDbPath(newPath);
				if (newDbRo != null && !this.ctx.isExcluded(newPath)) await this.reconcileReadOnly(newDbRo, newPath);
				return;
			}
			// 옛 경로가 동기화 범위 안이면 tombstone(md/asset 공통)
			const oldDb = this.ctx.toDbPath(oldPath);
			if (oldDb != null && !this.ctx.isExcluded(oldPath)) {
				await this.uploader.tombstonePath(oldDb);
			}
			// 새 경로가 범위 안이면 업로드(md/asset 공통). 폴더 단위 이동의 파일 폭주도 동시성 한도로 직렬화(P-3).
			const newDb = this.ctx.toDbPath(newPath);
			if (newDb != null && !this.ctx.isExcluded(newPath)) {
				this.ctx.markPending(newDb);
				try {
					await this.withUploadSlot(() => this.uploader.uploadPath(newPath));
				} finally {
					this.ctx.clearPending(newDb);
				}
			}
		} catch (e) {
			this.logWriteFailure(
				newPath,
				e,
				t("sync.rename_handling_failed", { from: oldPath, to: newPath, err: errMessage(e) }),
			);
		}
	}

	/**
	 * 삭제.
	 *  - .deleted/ 안의 파일을 지우면 → DB 문서 영구 제거(purge). 아카이브가 무한히 쌓이지 않게.
	 *  - 일반 파일 삭제 → tombstone(상대 vault는 정책대로 처리, 기술문서 §10.4).
	 */
	private onDelete(file: TAbstractFile): void {
		// 폴더 삭제: Obsidian은 폴더 1건의 delete 이벤트만 내고 내부 파일별 이벤트는 내지 않는다 —
		// 그래서 폴더 안 파일들이 tombstone되지 않아 상대(구성원)에게 전파되지 않고 원래 위치에 남았다(현장 버그).
		if (file instanceof TFolder) {
			if (this.ctx.isStructuralSuppressed(file.path)) return; // applier가 일으킨 폴더 이동/삭제 echo
			void this.handleFolderDelete(file.path).catch((e) =>
				this.logWriteFailure(file.path, e, t("sync.delete_handling_failed", { path: file.path, err: errMessage(e) })),
			);
			return;
		}
		if (!(file instanceof TFile)) return;
		const localPath = file.path;
		if (this.ctx.isStructuralSuppressed(localPath)) return; // applier가 일으킨 삭제/이동 echo

		// .deleted/ 안에서 삭제 → purge
		const archivedDb = this.ctx.archiveDbPath(localPath);
		if (archivedDb != null) {
			void this.uploader
				.purgePath(archivedDb)
				.catch((e) =>
					this.logWriteFailure(localPath, e, t("sync.purge_failed", { path: localPath, err: errMessage(e) })),
				);
			return;
		}

		// 일반 삭제 → tombstone (단, 읽기전용 공유 공간은 어떤 구성원도 삭제 불가 → 복원)
		if (this.ctx.isExcluded(localPath)) return;
		const dbPath = this.ctx.toDbPath(localPath);
		if (dbPath == null) return;
		void this.handleDelete(dbPath, localPath).catch((e) =>
			this.logWriteFailure(localPath, e, t("sync.delete_handling_failed", { path: localPath, err: errMessage(e) })),
		);
	}

	/**
	 * 삭제 처리: 읽기전용 공유 공간에서는 **어떤 구성원도(실시간 참여자 포함)** 공유 파일을 삭제할 수 없다 —
	 * 관리자만 제거한다. tombstone을 만들지 않고 로컬 라이브 사본을 복원한다(참조 파일·공동 작업물 보호).
	 * 읽기전용 공유가 아니면(개인 mirror·비읽기전용 공간) 정상 tombstone.
	 */
	private async handleDelete(dbPath: string, localPath: string): Promise<void> {
		if (this.ctx.isReadOnlyShared) {
			await this.reconcileReadOnly(dbPath, localPath);
			return;
		}
		await this.uploader.tombstonePath(dbPath);
	}

	/**
	 * 폴더 삭제 전파(현장 버그 #): 폴더 삭제 시점엔 vault 파일이 이미 사라졌으므로, 로컬 pouch에서 그 폴더
	 * 아래 살아있는 note/asset 문서를 찾아 **파일 삭제와 동일 경로(handleDelete)** 로 처리한다 —
	 * 관리자는 tombstone(전파), 읽기전용 구성원은 reconcileReadOnly(복원). Obsidian이 폴더 안 파일별
	 * delete 이벤트를 따로 내든 말든(버전·플랫폼차) 멱등하게 동작한다(이미 tombstone이면 건너뜀).
	 * 안전상 localRoot 전체 삭제(folderDb="")는 한 이벤트로 전부 tombstone하지 않는다 — 하위 폴더만 다룬다.
	 */
	private async handleFolderDelete(folderLocalPath: string): Promise<void> {
		const folderDb = this.ctx.toDbPath(folderLocalPath);
		if (folderDb == null || folderDb === "") return; // localRoot 밖 또는 루트 전체(과도 삭제 방지)
		const prefix = folderDb + "/";
		const notes = await this.ctx.pouch.allDocsByPrefix<NoteDoc>(noteId(prefix));
		const assets = await this.ctx.pouch.allDocsByPrefix<AssetDoc>(assetId(prefix));
		for (const doc of [...notes, ...assets]) {
			if (doc.deleted) continue; // 이미 tombstone
			const localPath = this.ctx.toLocalPath(doc.path);
			if (this.ctx.isExcluded(localPath)) continue; // 보관/충돌/제외 폴더는 대상 아님
			await this.handleDelete(doc.path, localPath);
		}
	}

	/**
	 * 읽기전용 공유 공간에서 구성원의 파일 변경(생성·수정·삭제·이름변경)을 정본 상태로 되돌린다 —
	 * "변경 내용이 기기에 보관"되지 않고 변경 전으로 복원된다(공유 파일은 관리자·실시간 세션만 바꿀 수 있음).
	 *  - 정본(로컬 pouch 라이브 문서)이 있으면 그 내용으로 vault를 **강제** 복원(편집·삭제 취소).
	 *    applyDoc/applyAsset의 충돌·pending 분기는 쓰기 없이 반환할 수 있어 정본을 직접 쓴다.
	 *  - 정본이 없으면(구성원이 새로 만든/이름변경한 파일) vault에서 제거.
	 * guard.mark/suppressStructural로 watcher 에코를 막고, reverting 가드로 오토세이브 재진입 루프를 막는다.
	 */
	private async reconcileReadOnly(dbPath: string, localPath: string): Promise<void> {
		if (this.reverting.has(localPath)) return; // 재진입/오토세이브 루프 방지
		this.reverting.add(localPath);
		const ctx = this.ctx;
		try {
			const isMd = ctx.isMarkdown(dbPath);
			const id = isMd ? noteId(dbPath) : assetId(dbPath);
			const doc = await ctx.pouch.get<NoteDoc | AssetDoc>(id).catch(() => null);
			if (doc && !doc.deleted) {
				ctx.guard.mark(localPath, doc.contentHash);
				try {
					if (isMd) {
						await ctx.writeVaultFile(localPath, (doc as NoteDoc).content ?? "");
					} else {
						const data = await ctx.pouch.getAssetBinary(id);
						if (data != null) await ctx.writeVaultBinary(localPath, data);
					}
				} finally {
					ctx.guard.releaseAfterDelay(localPath);
				}
			} else {
				// 정본 없음 → 구성원이 새로 만든/이름변경한 파일이므로 제거(읽기전용엔 추가 불가).
				const file = ctx.getFile(localPath);
				if (file) {
					ctx.suppressStructural(localPath);
					await ctx.deleteVaultFile(file);
				}
			}
			ctx.logger.warn(t("sync.readonly_change_reverted", { path: dbPath }), true);
		} finally {
			// 잠깐 뒤 가드 해제 — 복원·삭제가 일으킨 에코(오토세이브 포함)가 다시 reconcile을 트리거하지 않게.
			setTimeout(() => this.reverting.delete(localPath), 1500);
		}
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
			// 동시성 한도(평가 P-3) — 대량 작업에서 디바운스 타이머가 같은 시각에 만료해도
			// 읽기+해시+put이 한꺼번에 실행되지 않는다(메인 스레드 정체·메모리 스파이크 방지).
			await this.withUploadSlot(() => this.uploader.uploadPath(localPath));
		} catch (e) {
			this.ctx.logger.error(
				t("sync.upload_failed", { path: localPath, err: errMessage(e) }),
			);
		} finally {
			this.ctx.clearPending(dbPath);
		}
	}

	// --- 업로드 동시성 제한(평가 P-3) ---
	private static readonly MAX_CONCURRENT_UPLOADS = 3;
	private activeUploads = 0;
	private uploadWaiters: Array<() => void> = [];

	private async withUploadSlot<T>(fn: () => Promise<T>): Promise<T> {
		if (this.activeUploads >= LocalWatcher.MAX_CONCURRENT_UPLOADS) {
			await new Promise<void>((resolve) => this.uploadWaiters.push(resolve));
		}
		this.activeUploads++;
		try {
			return await fn();
		} finally {
			this.activeUploads--;
			this.uploadWaiters.shift()?.();
		}
	}
}
