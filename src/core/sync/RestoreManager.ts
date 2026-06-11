import { MirrorContext } from "./MirrorContext";
import { Uploader } from "./Uploader";
import { NoteDoc, AssetDoc, noteId, assetId } from "../model/types";
import { isRecoverable, restoreTargetPath, RestoreCollision } from "./restoreAction";
import { insertLabelBeforeExt } from "../path/path";
import { listPurges, removePurge, b64ToAb, PurgeSnapshot } from "./recentPurge";
import { listDeleteModify, removeDeleteModify, DeleteModifyItem } from "./deleteModifyQueue";
import { t } from "../../i18n";

export type DeleteModifyChoice = "delete" | "keep-remote" | "keep-both";

/**
 * 삭제 파일 복구. 보고서 §2 P1.
 *
 * tombstone(deleted=true) 문서를 사용자가 다시 살릴 수 있게 한다.
 * - 노트: tombstone이 content를 보존하므로 DB에서 바로 복구.
 * - 첨부: tombstone은 바이너리가 없으므로 archive(_삭제됨/) vault 사본이 있을 때만 복구.
 */
export interface DeletedItem {
	kind: "note" | "asset";
	dbPath: string;
	localPath: string; // 원래 위치(현재 localRoot 기준)
	deletedAt?: string;
	deletedBy?: string;
	deletedByRole?: string;
	remoteDb: string;
	memberId: string;
	memberName: string;
	recoverable: boolean;
}

export type RestoreResult = "restored" | "skipped-exists" | "unrecoverable" | "not-deleted";

export interface RestoreOptions {
	collision?: RestoreCollision; // 원래 위치에 파일이 있을 때 처리(기본 keep-both)
	toLocalPath?: string; // "다른 이름으로 복구" — 명시 경로(충돌 정책 무시)
}

export class RestoreManager {
	constructor(
		private ctx: MirrorContext,
		private uploader: Uploader,
	) {}

	/** 이 링크의 삭제된(tombstone) 파일 목록. */
	async listDeleted(): Promise<DeletedItem[]> {
		const ctx = this.ctx;
		const out: DeletedItem[] = [];
		for (const d of await ctx.pouch.allNotes()) {
			if (!d.deleted) continue;
			out.push(this.toItem("note", d, isRecoverable("note", { hasContent: !!d.content && !d.contentStripped, hasArchiveCopy: false })));
		}
		if (ctx.settings.syncAssets) {
			for (const d of await ctx.pouch.allAssets()) {
				if (!d.deleted) continue;
				const hasArchiveCopy = ctx.fileExists(ctx.archiveLocalPath(d.path));
				out.push(this.toItem("asset", d, isRecoverable("asset", { hasContent: false, hasArchiveCopy })));
			}
		}
		return out;
	}

	private toItem(kind: "note" | "asset", doc: NoteDoc | AssetDoc, recoverable: boolean): DeletedItem {
		const ctx = this.ctx;
		return {
			kind,
			dbPath: doc.path,
			localPath: ctx.toLocalPath(doc.path),
			deletedAt: doc.deletedAt,
			deletedBy: doc.deletedBy,
			deletedByRole: doc.deletedByRole,
			remoteDb: ctx.remoteDb,
			memberId: ctx.memberId,
			memberName: ctx.memberName,
			recoverable,
		};
	}

	/** 삭제된 파일을 vault + DB로 복구(deleted=false, version+1). */
	async restore(dbPath: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
		const ctx = this.ctx;
		const isMd = ctx.isMarkdown(dbPath);
		const id = isMd ? noteId(dbPath) : assetId(dbPath);
		const doc = await ctx.pouch.get<NoteDoc | AssetDoc>(id);
		if (!doc || !doc.deleted) return "not-deleted";

		// 대상 경로 결정(다른 이름 지정 시 충돌 정책 무시).
		const baseLocal = ctx.toLocalPath(dbPath);
		const target = opts.toLocalPath ?? restoreTargetPath(baseLocal, ctx.fileExists(baseLocal), opts.collision ?? "keep-both");
		if (target == null) return "skipped-exists";
		const targetDb = ctx.toDbPath(target);
		if (targetDb == null) return "unrecoverable";

		if (isMd) {
			const note = doc as NoteDoc;
			// contentStripped: 보존 기간 경과로 내용이 비워진 tombstone(I-3) — 빈 파일로 "복구"되지 않게 차단.
			if (note.content == null || note.contentStripped) return "unrecoverable";
			await this.writeAndRevive(target, targetDb, note.content);
		} else {
			// 첨부: archive 사본에서만 복구.
			const bin = await ctx.readVaultBinary(ctx.archiveLocalPath(dbPath));
			if (bin == null) return "unrecoverable";
			const prev = (await ctx.pouch.get<AssetDoc>(assetId(targetDb)))?.version ?? 0;
			ctx.guard.mark(target, (doc as AssetDoc).contentHash);
			await ctx.writeVaultBinary(target, bin);
			ctx.guard.releaseAfterDelay(target);
			await ctx.pouch.putAsset(await ctx.buildAssetDoc(targetDb, bin, prev), bin);
		}

		// 남은 archive(_삭제됨/) 사본 정리(echo는 suppress로 차단).
		const archivePath = ctx.archiveLocalPath(dbPath);
		const af = ctx.getFile(archivePath);
		if (af && archivePath !== target) {
			ctx.suppressStructural(archivePath);
			await ctx.deleteVaultFile(af);
		}

		// 다른 이름으로 복구했으면(원래 위치와 다른 경로) 원래 tombstone을 정리해 삭제 목록에 남지 않게 한다.
		// 같은 위치 복구는 writeAndRevive/putAsset가 같은 id를 deleted=false로 되살려 자연히 목록에서 빠진다.
		if (targetDb !== dbPath) {
			const old = await ctx.pouch.get<NoteDoc | AssetDoc>(id);
			if (old?._rev) await ctx.pouch.removeRev(id, old._rev).catch(() => undefined);
		}

		ctx.logger.ok(t("recovery.recovered", { path: target }), true);
		return "restored";
	}

	private async writeAndRevive(target: string, targetDb: string, content: string): Promise<void> {
		const ctx = this.ctx;
		const prev = (await ctx.pouch.get<NoteDoc>(noteId(targetDb)))?.version ?? 0;
		const fresh = await ctx.buildNoteDoc(targetDb, content, prev); // contentHash 계산됨
		ctx.guard.mark(target, fresh.contentHash); // vault 쓰기 echo 차단
		await ctx.writeVaultFile(target, content);
		ctx.guard.releaseAfterDelay(target);
		await ctx.pouch.put(fresh);
		await ctx.versions.snapshot(targetDb, content, "restore", fresh.version); // 복구 시점 버전 기록
	}

	/** DB 문서 영구 삭제(purge). */
	purge(dbPath: string): Promise<"purged" | "skipped"> {
		return this.uploader.purgePath(dbPath);
	}

	// --- 최근 영구 삭제 되돌리기 (보고서 §2 P2) ---
	listRecentPurges(): Promise<PurgeSnapshot[]> {
		return listPurges(this.ctx.pouch);
	}

	/** 영구 삭제된 문서를 스냅샷에서 되살린다. */
	async undoPurge(id: string): Promise<RestoreResult> {
		const ctx = this.ctx;
		const snap = (await listPurges(ctx.pouch)).find((s) => s.id === id);
		if (!snap || !snap.recoverable) return "unrecoverable";
		const localPath = ctx.toLocalPath(snap.dbPath);
		const target = restoreTargetPath(localPath, ctx.fileExists(localPath), "keep-both");
		if (target == null) return "skipped-exists";
		const targetDb = ctx.toDbPath(target);
		if (targetDb == null) return "unrecoverable";

		if (snap.kind === "note") {
			if (snap.content == null) return "unrecoverable";
			await this.writeAndRevive(target, targetDb, snap.content);
		} else {
			if (!snap.binaryB64) return "unrecoverable";
			const bin = b64ToAb(snap.binaryB64);
			const prev = (await ctx.pouch.get<AssetDoc>(assetId(targetDb)))?.version ?? 0;
			ctx.guard.mark(target, (await ctx.buildAssetDoc(targetDb, bin, prev)).contentHash);
			await ctx.writeVaultBinary(target, bin);
			ctx.guard.releaseAfterDelay(target);
			await ctx.pouch.putAsset(await ctx.buildAssetDoc(targetDb, bin, prev), bin);
		}
		await removePurge(ctx.pouch, id);
		ctx.logger.ok(t("recovery.undid_permanent_delete", { path: target }), true);
		return "restored";
	}

	clearPurgeEntry(id: string): Promise<void> {
		return removePurge(this.ctx.pouch, id);
	}

	// --- 삭제/수정 충돌 큐 (보고서 §2 P2) ---
	listDeleteModify(): Promise<DeleteModifyItem[]> {
		return listDeleteModify(this.ctx.pouch);
	}

	/**
	 * 삭제/수정 충돌 해소.
	 * - delete: 내 삭제 적용(로컬 파일 제거 + tombstone).
	 * - keep-remote: 원격 수정 유지(큐에서만 제거 — 파일은 그대로 둔다).
	 * - keep-both: 원격 수정본을 다른 이름으로 보관한 뒤 원본은 삭제.
	 */
	async resolveDeleteModify(dbPath: string, choice: DeleteModifyChoice): Promise<void> {
		const ctx = this.ctx;
		const localPath = ctx.toLocalPath(dbPath);

		if (choice === "keep-remote") {
			// 원격 수정을 유지 = 로컬에서 삭제된 파일을 원격 내용으로 vault에 되살린다.
			// (큐 항목만 지우면 파일이 삭제된 채로 남아 "원격 유지" 선택과 어긋난다.)
			if (ctx.isMarkdown(dbPath)) {
				const doc = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
				if (doc?.content != null && !doc.deleted) await this.writeAndRevive(localPath, dbPath, doc.content);
			} else {
				const bin = await ctx.pouch.getAssetBinary(assetId(dbPath));
				if (bin) {
					const prev = (await ctx.pouch.get<AssetDoc>(assetId(dbPath)))?.version ?? 0;
					const fresh = await ctx.buildAssetDoc(dbPath, bin, prev);
					ctx.guard.mark(localPath, fresh.contentHash);
					await ctx.writeVaultBinary(localPath, bin);
					ctx.guard.releaseAfterDelay(localPath);
					await ctx.pouch.putAsset(fresh, bin);
				}
			}
			await removeDeleteModify(ctx.pouch, dbPath);
			ctx.logger.ok(t("recovery.delete_modify_conflict_resolved", { choice, path: dbPath }), true);
			return;
		}

		if (choice === "keep-both") {
			// insertLabelBeforeExt(dbPath, …) 결과는 이미 dbPath다. toDbPath로 다시 변환하면
			// localRoot 있는 링크(교사 모드 학생 폴더)에서 localRoot 밖으로 판정돼 null → 복사본 미생성.
			const copyDb = insertLabelBeforeExt(dbPath, t("recovery.remote_edit"));
			const copyLocal = ctx.toLocalPath(copyDb);
			if (ctx.isMarkdown(dbPath)) {
				const doc = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
				if (doc?.content != null) await this.writeAndRevive(copyLocal, copyDb, doc.content);
			} else {
				const bin = await ctx.pouch.getAssetBinary(assetId(dbPath));
				if (bin) {
					const prev = (await ctx.pouch.get<AssetDoc>(assetId(copyDb)))?.version ?? 0;
					await ctx.writeVaultBinary(copyLocal, bin);
					await ctx.pouch.putAsset(await ctx.buildAssetDoc(copyDb, bin, prev), bin);
				}
			}
		}

		// delete / keep-both 공통: 로컬 원본 제거 + tombstone.
		const file = ctx.getFile(localPath);
		if (file) {
			ctx.suppressStructural(localPath);
			await ctx.deleteVaultFile(file);
		}
		await this.uploader.tombstonePath(dbPath);
		await removeDeleteModify(ctx.pouch, dbPath);
		ctx.logger.ok(t("recovery.delete_modify_conflict_resolved", { choice, path: dbPath }), true);
	}
}
