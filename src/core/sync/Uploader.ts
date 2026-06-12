import { MirrorContext } from "./MirrorContext";
import { NoteDoc, AssetDoc, noteId, assetId } from "../model/types";
import { sha256 } from "../hash/hash";
import { recordPurge, abToB64, PURGE_ASSET_CAP, PurgeSnapshot } from "./recentPurge";
import { t } from "../../i18n";

export type UploadResult =
	| "uploaded"
	| "skipped-same"
	| "skipped-outside"
	| "skipped-excluded"
	| "skipped-asset-off"
	| "skipped-toolarge"
	| "skipped-missing"
	| "skipped-deleted"
	| "skipped-conflict";

/**
 * 로컬 vault 파일 → 로컬 PouchDB upsert. 기술문서 §11.2 / §18.2 / §8.2.
 *
 * markdown은 note 문서, 그 외 파일은 asset 문서(+PouchDB attachment)로 올린다.
 * 동일 contentHash면 생략(§18.2). lastModifiedDeviceId=내 deviceId라 에코는 Applier가 무시.
 */
export class Uploader {
	constructor(private ctx: MirrorContext) {}

	async uploadPath(localPath: string): Promise<UploadResult> {
		const ctx = this.ctx;
		if (ctx.isExcluded(localPath)) return "skipped-excluded";
		const dbPath = ctx.toDbPath(localPath);
		if (dbPath == null || !ctx.isValidDbPath(dbPath)) return "skipped-outside";

		return ctx.isMarkdown(localPath) ? this.uploadNote(localPath, dbPath) : this.uploadAsset(localPath, dbPath);
	}

	/**
	 * vault 파일 대신 주어진 내용으로 note 업로드(실시간 스냅샷용). 경로 매핑/제외/해시 dedupe는 동일.
	 * 열린 에디터를 건드리지 않고 로컬 DB에만 기록 → replication이 원격 전파.
	 */
	async uploadContent(localPath: string, content: string): Promise<UploadResult> {
		const ctx = this.ctx;
		if (ctx.isExcluded(localPath)) return "skipped-excluded";
		const dbPath = ctx.toDbPath(localPath);
		if (dbPath == null || !ctx.isValidDbPath(dbPath)) return "skipped-outside";
		if (!ctx.isMarkdown(localPath)) return "skipped-outside";

		const newHash = await sha256(content);
		// 읽기→쓰기 사이에 pull이 끼어들면 rev 검증 put이 conflict를 돌려준다 — 전제조건을
		// 새 문서 기준으로 재검증하고 재시도한다(LWW가 tombstone을 검증 없이 덮던 창 봉쇄 — L-1).
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
			// 교사 삭제 tombstone은 실시간 스냅샷으로 되살리지 않는다(교사 삭제가 세션보다 우선 — 부활 방지).
			if (existing?.deleted && existing.deletedByRole === "manager") return "skipped-deleted";
			if (existing && !existing.deleted && existing.contentHash === newHash) return "skipped-same";

			// 재시도 진입 = 직전 put 사이에 다른 쓰기가 끼어듦. 끼어든 게 다른 기기의 새 내용이면
			// 덮기 전에 버전 히스토리에 보존한다(tombstonePath와 동형 — 평가 D-1).
			if (attempt > 0) await this.preserveInterveningNote(dbPath, existing, newHash);
			const doc = await ctx.buildNoteDoc(dbPath, content, existing?.version ?? 0);
			if ((await ctx.pouch.putWithRev(doc, existing?._rev)) === "conflict") continue;
			await ctx.versions.snapshot(dbPath, content, "modify", doc.version); // 실시간 편집도 버전 기록(dedupe 있음)
			this.markUploaded(dbPath);
			return "uploaded";
		}
		ctx.logger.warn(t("sync.upload_retry_conflict", { path: dbPath }));
		return "skipped-conflict";
	}

	private async uploadNote(localPath: string, dbPath: string): Promise<UploadResult> {
		const ctx = this.ctx;
		const content = await ctx.readVaultFile(localPath);
		if (content == null) return "skipped-missing";
		const newHash = await sha256(content);

		// 동일하면 생략. tombstone 위 업로드(부활)는 의도적 재생성/편집(파일이 삭제 시점보다 새로 수정됨)만 —
		// 잔존 사본(삭제 적용 보류·실패로 남은 옛 파일)이 전체 동기화에서 삭제를 전역 무효화하지 않게.
		// rev 검증 put + 전제조건 재검증 재시도(L-1): 읽기→쓰기 사이에 끼어든 tombstone을 LWW로 덮지 않는다.
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
			if (existing?.deleted && !this.modifiedAfterTombstone(localPath, existing, newHash)) return "skipped-deleted";
			if (existing && !existing.deleted && existing.contentHash === newHash) return "skipped-same";

			// 재시도 진입 시 끼어든 다른 기기의 새 내용을 보존(평가 D-1, uploadContent와 동일).
			if (attempt > 0) await this.preserveInterveningNote(dbPath, existing, newHash);
			const doc = await ctx.buildNoteDoc(dbPath, content, existing?.version ?? 0);
			if ((await ctx.pouch.putWithRev(doc, existing?._rev)) === "conflict") continue;
			await ctx.versions.snapshot(dbPath, content, "modify", doc.version); // 버전 히스토리(편집 시점)
			this.markUploaded(dbPath);
			return "uploaded";
		}
		ctx.logger.warn(t("sync.upload_retry_conflict", { path: dbPath }));
		return "skipped-conflict";
	}

	private async uploadAsset(localPath: string, dbPath: string): Promise<UploadResult> {
		const ctx = this.ctx;
		if (!ctx.settings.syncAssets) return "skipped-asset-off";

		const maxBytes = (ctx.settings.maxAttachmentMB || 0) * 1024 * 1024;

		// 큰 파일을 메모리에 읽기 전에 stat.size로 먼저 한도 초과를 판정(모바일 메모리 보호, §24.6).
		if (maxBytes > 0) {
			const size = ctx.getFile(localPath)?.stat.size;
			if (size != null && size > maxBytes) {
				ctx.logger.warn(
					t("sync.skipped_attachment_exceeds_size_limit_mb", { path: dbPath, size: (size / 1024 / 1024).toFixed(1) }),
				);
				return "skipped-toolarge";
			}
		}

		const data = await ctx.readVaultBinary(localPath);
		if (data == null) return "skipped-missing";

		if (maxBytes > 0 && data.byteLength > maxBytes) {
			ctx.logger.warn(
				t("sync.skipped_attachment_exceeds_size_limit_mb", {
					path: dbPath,
					size: (data.byteLength / 1024 / 1024).toFixed(1),
				}),
			);
			return "skipped-toolarge";
		}

		const newHash = await sha256(data);
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await ctx.pouch.get<AssetDoc>(assetId(dbPath));
			// 노트와 동일한 부활 규칙 — 잔존 사본은 tombstone을 되살리지 않는다.
			if (existing?.deleted && !this.modifiedAfterTombstone(localPath, existing, newHash)) return "skipped-deleted";
			if (existing && !existing.deleted && existing.contentHash === newHash) return "skipped-same";

			// 첨부는 버전 히스토리가 없어 끼어든 원격 바이너리가 유일본일 수 있다 — _충돌/에 보존(평가 D-1).
			if (attempt > 0) await this.preserveInterveningAsset(dbPath, existing, newHash);
			const doc = await ctx.buildAssetDoc(dbPath, data, existing?.version ?? 0);
			if ((await ctx.pouch.putAssetWithRev(doc, data, existing?._rev)) === "conflict") continue;
			this.markUploaded(dbPath);
			return "uploaded";
		}
		ctx.logger.warn(t("sync.upload_retry_conflict", { path: dbPath }));
		return "skipped-conflict";
	}

	/**
	 * 업로드 재시도에 끼어든 다른 기기의 새 노트 내용을 덮기 전에 버전 히스토리로 보존(평가 D-1).
	 * tombstonePath는 같은 상황에서 스냅샷 후 덮지만 uploadNote/uploadContent에는 이 단계가 없어,
	 * pull과 로컬 업로드가 ms 단위로 겹칠 때 끼어든 내용이 흔적 없이 선형 덮어쓰기될 수 있었다.
	 */
	private async preserveInterveningNote(dbPath: string, existing: NoteDoc | null, newHash: string): Promise<void> {
		if (!existing || existing.deleted || existing.content == null) return;
		if (existing.lastModifiedDeviceId === this.ctx.settings.deviceId) return; // 내 기기 쓰기 — 보존 불필요
		if (existing.contentHash === newHash) return; // 같은 내용 — 보존할 것 없음
		await this.ctx.versions.snapshot(dbPath, existing.content, "conflict", existing.version ?? 0);
	}

	/**
	 * preserveInterveningNote의 첨부 버전. 첨부는 버전 히스토리가 없으므로
	 * 끼어든 원격 바이너리를 _충돌/ 사본으로 보존한다. 보존 실패가 업로드를 막지는 않는다.
	 */
	private async preserveInterveningAsset(dbPath: string, existing: AssetDoc | null, newHash: string): Promise<void> {
		const ctx = this.ctx;
		if (!existing || existing.deleted) return;
		if (existing.lastModifiedDeviceId === ctx.settings.deviceId) return;
		if (existing.contentHash === newHash) return;
		const data = await ctx.pouch.getAssetBinary(assetId(dbPath)).catch(() => null);
		if (data == null) return;
		try {
			await ctx.writeVaultBinary(ctx.conflictLocalPath(dbPath), data);
			ctx.logger.warn(
				t("sync.attachment_conflict_held_preserve_local_keeping", { path: ctx.toLocalPath(dbPath) }),
			);
		} catch {
			/* 보존 실패는 업로드를 막지 않는다 */
		}
	}

	/**
	 * tombstone 이후 로컬 파일이 실제로 수정/재생성됐는지.
	 * 1) 내용 해시가 tombstone 시점과 다르면 재생성/편집 — 기기 간 시계가 어긋나도 안전한 판정.
	 * 2) 해시가 같으면(잔존 사본 또는 동일 내용 복원) mtime 비교 — 잔존 사본의 mtime은 삭제 이전
	 *    쓰기 시점이라 tombstone mtime보다 항상 과거다. 동시 편집·삭제가 겹친 경우라면 삭제/수정
	 *    충돌이므로 보존(부활) 쪽이 안전해 슬랙 없이 strict 비교.
	 */
	private modifiedAfterTombstone(localPath: string, tomb: { mtime?: number; contentHash?: string }, localHash?: string): boolean {
		if (localHash && tomb.contentHash && localHash !== tomb.contentHash) return true;
		const fileMtime = this.ctx.getFile(localPath)?.stat.mtime ?? 0;
		return fileMtime > (tomb.mtime ?? 0);
	}

	private markUploaded(dbPath: string): void {
		this.ctx.status.lastUploadAt = Date.now();
		this.ctx.status.lastError = undefined;
		this.ctx.logger.ok(t("sync.uploaded_local_remote", { path: dbPath }));
		this.ctx.notifyLocalWrite?.(); // 이벤트 구동 모드: 원격 push 깨우기
	}

	/** 삭제/이름변경 시 옛 경로를 tombstone 처리(note/asset 공통). 기술문서 §8.3 / §10.3. */
	async tombstonePath(dbPath: string): Promise<"tombstoned" | "skipped"> {
		const ctx = this.ctx;
		const s = ctx.settings;
		// 첨부 동기화 off 기기는 asset 변경을 발신하지 않는다(수신 측 applyAsset과 동일 원칙).
		// off 기기의 stale 사본 삭제/이름변경이 최신 원격 첨부를 tombstone하는 비대칭을 막고,
		// rename 시 "옛 경로 tombstone만 전파되고 새 경로는 업로드되지 않는" 첨부 소실도 막는다.
		if (!ctx.isMarkdown(dbPath) && !s.syncAssets) return "skipped";
		const id = ctx.isMarkdown(dbPath) ? noteId(dbPath) : assetId(dbPath);
		// rev 검증 put + 재시도(L-1): 읽기→쓰기 사이에 새 원격 내용이 끼어들면 그 버전을 스냅샷한 뒤 tombstone.
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await ctx.pouch.get<NoteDoc | AssetDoc>(id);
			if (!existing || existing.deleted) return "skipped";

			// 삭제 직전 내용을 버전 히스토리에 보존(마크다운).
			if (ctx.isMarkdown(dbPath) && (existing as NoteDoc).content != null) {
				await ctx.versions.snapshot(dbPath, (existing as NoteDoc).content, "delete", existing.version ?? 0);
			}

			const now = Date.now();
			const doc: any = {
				...existing,
				deleted: true,
				deletedAt: new Date(now).toISOString(),
				deletedBy: s.userId,
				deletedByRole: s.role,
				deleteMode: s.deletePolicy,
				version: (existing.version ?? 0) + 1,
				mtime: now,
				lastModifiedBy: s.userId,
				lastModifiedRole: s.role,
				lastModifiedDeviceId: s.deviceId,
				updatedAt: new Date(now).toISOString(),
			};
			delete doc._attachments; // tombstone은 바이너리 불필요
			if ((await ctx.pouch.putWithRev(doc, existing._rev)) === "conflict") continue;
			ctx.logger.ok(t("sync.tombstone_marked_deleted", { path: dbPath }));
			ctx.notifyLocalWrite?.();
			return "tombstoned";
		}
		ctx.logger.warn(t("sync.upload_retry_conflict", { path: dbPath }));
		return "skipped";
	}

	/** DB 문서 영구 제거(purge, note/asset 공통). .deleted/에서 지웠을 때. */
	async purgePath(dbPath: string): Promise<"purged" | "skipped"> {
		const ctx = this.ctx;
		// tombstone과 동일 — 첨부 동기화 off 기기는 asset purge를 발신하지 않는다.
		if (!ctx.isMarkdown(dbPath) && !ctx.settings.syncAssets) return "skipped";
		const id = ctx.isMarkdown(dbPath) ? noteId(dbPath) : assetId(dbPath);
		const existing = await ctx.pouch.get<NoteDoc | AssetDoc>(id);
		if (!existing || !existing._rev) return "skipped";
		await this.snapshotBeforePurge(dbPath, existing); // '최근 영구 삭제' 되돌리기용
		await ctx.pouch.removeRev(id, existing._rev);
		ctx.logger.ok(t("sync.permanently_deleted_from_db_purge", { path: dbPath }));
		ctx.notifyLocalWrite?.();
		return "purged";
	}

	/** purge 직전 스냅샷을 capped 목록에 기록. 노트는 content(tombstone에 보존됨)로, 첨부는 cap 이하 바이너리만. */
	private async snapshotBeforePurge(dbPath: string, existing: NoteDoc | AssetDoc): Promise<void> {
		const ctx = this.ctx;
		const base = {
			id: `${dbPath}@${existing._rev}`,
			dbPath,
			purgedAt: Date.now(),
			purgedBy: ctx.settings.userId,
		};
		let snap: PurgeSnapshot;
		if (ctx.isMarkdown(dbPath)) {
			const content = (existing as NoteDoc).content;
			snap = { ...base, kind: "note", content, recoverable: content != null };
		} else {
			const bin = await ctx.pouch.getAssetBinary(assetId(dbPath)).catch(() => null);
			const ok = bin != null && bin.byteLength <= PURGE_ASSET_CAP;
			snap = {
				...base,
				kind: "asset",
				mime: (existing as AssetDoc).mime,
				binaryB64: ok ? abToB64(bin as ArrayBuffer) : undefined,
				recoverable: ok,
			};
		}
		try {
			await recordPurge(ctx.pouch, snap);
		} catch {
			/* 스냅샷 기록 실패는 purge를 막지 않는다 */
		}
	}
}
