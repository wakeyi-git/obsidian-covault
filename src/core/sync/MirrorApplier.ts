import { MirrorContext } from "./MirrorContext";
import { errMessage } from "../util/err";
import { ConflictManager } from "./ConflictManager";
import { NoteDoc, AssetDoc, assetId } from "../model/types";
import { sha256 } from "../hash/hash";
import { t } from "../../i18n";

/** 삭제(tombstone) 적용에 필요한 최소 형태(note/asset 공통). */
type DeletableDoc = {
	path: string;
	deleted: boolean;
	lastModifiedDeviceId: string;
	deleteMode?: "archive" | "propagate-delete" | "ignore-delete";
};

export type ApplyResult =
	| "applied"
	| "deleted"
	| "skipped-self"
	| "skipped-same"
	| "skipped-deleted"
	| "skipped-nonmd"
	| "skipped-excluded"
	| "skipped-pending"
	| "conflict";

/** _conflicts를 포함한 로컬 문서. */
type DocWithConflicts = NoteDoc & { _conflicts?: string[] };

/**
 * 로컬 PouchDB 문서 → 로컬 vault 적용. 기술문서 §11.4 / §16.2 / §14.
 *
 * 충돌 판정은 PouchDB의 _conflicts(리비전 충돌)를 신뢰의 기준으로 삼는다.
 * - 깨끗한(충돌 없는) 원격 갱신 → vault에 적용
 * - _conflicts 존재(양쪽이 분기 편집) → preserve-local: vault를 덮지 않고 보류·경고 (정식 해소는 Phase 3)
 * - 내 기기가 만든 내용이거나 업로드 대기 중인 로컬 편집 → 덮지 않음
 */
export class MirrorApplier {
	private loggedConflicts = new Set<string>();

	constructor(
		private ctx: MirrorContext,
		private conflicts: ConflictManager,
	) {}

	async applyDoc(doc: DocWithConflicts): Promise<ApplyResult> {
		const ctx = this.ctx;

		if (!ctx.isMarkdown(doc.path) || !ctx.isValidDbPath(doc.path)) return "skipped-nonmd";

		const localPath = ctx.toLocalPath(doc.path);
		// 보관(_삭제됨)·충돌(_충돌)·제외 폴더 경로는 동기화 대상이 아니다(업로드와 동일 규칙, 양방향 격리).
		if (ctx.isExcluded(localPath)) return "skipped-excluded";

		// 삭제(tombstone) 처리. 기술문서 §10.4 / §15.
		if (doc.deleted) return await this.applyDeletion(doc);

		// 실시간 세션 중이면 Yjs가 권위 → 원격 적용으로 라이브 에디터를 덮지 않는다.
		// (세션 종료 스냅샷이 정합하므로 별도 보존 불필요.)
		if (ctx.core.isRealtimeActive(localPath)) return "skipped-pending";

		const local = await ctx.readVaultFile(localPath);
		const localHash = local == null ? null : await sha256(local);

		// 이미 동일 내용 (충돌이 해소되어 양쪽이 같아졌을 수 있으니 남은 원격본 정리)
		if (localHash === doc.contentHash) {
			await this.conflicts.cleanupCopy(doc.path);
			return "skipped-same";
		}

		// 업로드 대기 중인 로컬 편집이면 vault를 덮지 않는다(레이스 방지) — 곧 업로드가 정합한다.
		// 단, 다른 기기의 원격 변경이 들어온 것이면 그 업로드가 원격본을 선형으로 덮어 _conflicts 분기조차
		// 남기지 않으므로(데이터 손실), 덮이기 전에 원격본을 _충돌/에 보존한다. 기술문서 §14.
		if (ctx.isPending(doc.path)) {
			if (doc.lastModifiedDeviceId !== ctx.settings.deviceId) {
				await this.conflicts.materialize(doc);
				if (!this.loggedConflicts.has(doc.path)) {
					this.loggedConflicts.add(doc.path);
					ctx.logger.warn(
						t("sync.remote_change_received_while_editing_keeping",
							{ path: localPath },
						),
						true,
					);
				}
			}
			return "skipped-pending";
		}

		const hasConflict = !!doc._conflicts && doc._conflicts.length > 0;
		if (hasConflict) {
			// 양쪽이 서로 다르게 편집 → 로컬 유지(preserve-local) + 원격본을 _충돌/에 꺼내 둠
			await this.conflicts.materialize(doc);
			if (!this.loggedConflicts.has(doc.path)) {
				this.loggedConflicts.add(doc.path);
				ctx.logger.warn(
					t("sync.conflict_held_preserve_local_both_sides",
						{ path: localPath },
					),
					true,
				);
			}
			return "conflict";
		}

		// 내 기기가 만든 내용인데 vault가 다르면, vault에 더 최신 로컬 편집이 있는 것 → 덮지 않음
		if (doc.lastModifiedDeviceId === ctx.settings.deviceId) {
			return "skipped-self";
		}

		// 충돌이 있던 경로인데 로컬이 원격과 다르면, 상대가 해소해 내 편집이 곧 덮일 차례.
		// 흔적 없이 잃지 않도록 내 버전을 먼저 보존한다. (데이터 손실 방지)
		if (local != null && this.conflicts.hadConflict(doc.path)) {
			await this.conflicts.preserveLocal(doc.path, local);
			ctx.logger.warn(
				t("sync.the_other_side_resolved_the_conflict", {
					path: ctx.localBackupPath(doc.path),
				}),
				true,
			);
		}

		// 충돌 없는 원격 갱신 → 적용 (guard로 에코 차단)
		this.loggedConflicts.delete(doc.path);
		await this.conflicts.cleanupCopy(doc.path); // 해소 전파로 들어온 갱신이면 남은 원격본 정리
		ctx.guard.mark(localPath, doc.contentHash);
		await ctx.writeVaultFile(localPath, doc.content);
		ctx.guard.releaseAfterDelay(localPath);
		ctx.status.lastDownloadAt = Date.now();
		ctx.logger.ok(t("sync.applied_remote_local", { path: localPath }));
		return "applied";
	}

	/**
	 * purge 전파: DB 문서가 영구 제거되면 이쪽 vault의 아카이브 사본(.deleted/<path>)도 정리.
	 * 사용자가 한쪽 .deleted/에서 지우면 다른 쪽 .deleted/ 사본도 따라 정리된다.
	 */
	async applyPurge(id: string): Promise<void> {
		const ctx = this.ctx;
		let dbPath: string;
		if (id.startsWith("note:")) dbPath = id.slice("note:".length);
		else if (id.startsWith("asset:")) dbPath = id.slice("asset:".length);
		else return;
		const archivePath = ctx.archiveLocalPath(dbPath);
		const file = ctx.getFile(archivePath);
		if (!file) return;
		ctx.suppressStructural(archivePath);
		await ctx.deleteVaultFile(file);
		ctx.logger.info(t("sync.purge_propagated_cleaned_up_archive", { path: archivePath }));
	}

	/**
	 * asset(첨부파일) 적용. applyDoc의 바이너리 버전. 충돌은 보존(로컬 유지)만, 비교/해소 UI는 없음.
	 */
	async applyAsset(doc: AssetDoc & { _conflicts?: string[] }): Promise<ApplyResult> {
		const ctx = this.ctx;
		if (!ctx.isValidDbPath(doc.path)) return "skipped-nonmd";

		const localPath = ctx.toLocalPath(doc.path);
		if (ctx.isExcluded(localPath)) return "skipped-excluded"; // 보관/충돌/제외 폴더 격리

		// 첨부 동기화를 끈 기기는 첨부를 일절 처리하지 않는다(삭제·충돌 보존 포함) — on↔off 비대칭 방지.
		// (이전엔 tombstone만 적용하고 충돌 보존은 건너뛰어, off 기기가 로컬 첨부를 보존 없이 삭제할 수 있었다.)
		if (!ctx.settings.syncAssets) return "skipped-nonmd";

		if (doc.deleted) return await this.applyDeletion(doc);

		const local = await ctx.readVaultBinary(localPath);
		const localHash = local == null ? null : await sha256(local);
		const hasConflict = !!doc._conflicts && doc._conflicts.length > 0;

		// 업로드 대기 중인 로컬 편집이면 덮지 않되, 다른 기기의 원격 바이너리는 곧 덮여 사라지므로 _충돌/에 보존.
		if (ctx.isPending(doc.path)) {
			if (doc.lastModifiedDeviceId !== ctx.settings.deviceId) await this.preserveRemoteAsset(doc, localPath);
			return "skipped-pending";
		}

		// 충돌(_conflicts)이면 winner가 live와 같아도(로컬 branch가 winner) 실제 원격 리프를 _충돌/에 보존.
		// (skipped-same보다 먼저 — winner==live로 조기 반환하면 원격본이 영영 보존되지 않는다. 보고서 P1.)
		if (hasConflict) {
			await this.preserveRemoteAsset(doc, localPath);
			return "conflict";
		}

		if (localHash === doc.contentHash) return "skipped-same";
		if (doc.lastModifiedDeviceId === ctx.settings.deviceId) return "skipped-self";

		const data = await ctx.pouch.getAssetBinary(assetId(doc.path));
		if (data == null) {
			ctx.logger.warn(t("sync.no_attachment_data_waiting_for_propagation", { path: doc.path }));
			return "skipped-nonmd";
		}
		ctx.guard.mark(localPath, doc.contentHash);
		await ctx.writeVaultBinary(localPath, data);
		ctx.guard.releaseAfterDelay(localPath);
		ctx.status.lastDownloadAt = Date.now();
		ctx.logger.ok(t("sync.applied_remote_local_attachment", { path: localPath }));
		return "applied";
	}

	/**
	 * winner + conflict 리프 중 **live 로컬 바이너리와 다른(원격)** 리프의 바이너리를 고른다.
	 * winner가 로컬 branch면 winner는 로컬본이므로, conflict 리프에서 실제 원격본을 찾는다(마크다운 pickRemoteLeaf와 동형).
	 */
	private async pickRemoteAssetBinary(doc: AssetDoc & { _conflicts?: string[] }, localPath: string): Promise<ArrayBuffer | null> {
		const ctx = this.ctx;
		const id = assetId(doc.path);
		const live = await ctx.readVaultBinary(localPath);
		const liveHash = live == null ? null : await sha256(live);
		const differs = async (bin: ArrayBuffer | null): Promise<boolean> =>
			bin != null && (liveHash == null || (await sha256(bin)) !== liveHash);

		const winnerBin = await ctx.pouch.getAssetBinary(id);
		if (await differs(winnerBin)) return winnerBin; // winner가 원격본인 일반적 경우
		for (const rev of doc._conflicts ?? []) {
			const bin = await ctx.pouch.getAssetBinaryRev(id, rev);
			if (await differs(bin)) return bin; // winner가 로컬이면 conflict 리프에서 원격본을 찾는다
		}
		return winnerBin; // 모든 리프가 live와 동일 → 보여줄 원격본 없음(폴백)
	}

	/**
	 * pending/충돌로 원격 바이너리가 곧 로컬 업로드에 덮일 때, **실제 원격** 바이너리를 _충돌/에 보존.
	 * 바이너리는 비교/병합 UI가 없으므로 파일로 꺼내 두고 경고만 1회 남긴다.
	 */
	private async preserveRemoteAsset(doc: AssetDoc & { _conflicts?: string[] }, localPath: string): Promise<void> {
		const ctx = this.ctx;
		const data = await this.pickRemoteAssetBinary(doc, localPath);
		if (data == null) return;
		try {
			await ctx.writeVaultBinary(ctx.conflictLocalPath(doc.path), data);
			if (!this.loggedConflicts.has(doc.path)) {
				this.loggedConflicts.add(doc.path);
				ctx.logger.warn(
					t("sync.attachment_conflict_held_preserve_local_keeping", { path: localPath }),
					true,
				);
			}
		} catch (e) {
			ctx.logger.error(
				t("sync.failed_to_save_attachment_conflict_copy", { path: localPath, err: errMessage(e) }),
			);
		}
	}

	/** tombstone 적용: 정책(archive/propagate-delete/ignore-delete)대로 로컬 파일 처리. */
	private async applyDeletion(doc: DeletableDoc): Promise<ApplyResult> {
		const ctx = this.ctx;

		// 내가 만든 tombstone의 에코 → 무시 (내 vault는 이미 처리됨)
		if (doc.lastModifiedDeviceId === ctx.settings.deviceId) return "skipped-self";

		// 받는 쪽(이 vault)의 정책을 따른다 — 각자 자기 vault의 삭제 처리(보관/즉시삭제/무시)를 제어한다.
		// (이전엔 tombstone의 deleteMode=삭제자 정책이 우선이라, 받는 쪽 설정이 무시되는 문제가 있었다.)
		const policy = ctx.settings.deletePolicy;
		if (policy === "ignore-delete") return "skipped-deleted";

		const localPath = ctx.toLocalPath(doc.path);
		// 실시간 세션 중인 파일은 삭제/보관을 보류 — 공동 편집 중인 라이브 파일을 _삭제됨으로 끌고 가지 않는다.
		// (세션 종료 스냅샷이 내용을 다시 올려 삭제를 무효화한다.)
		if (ctx.core.isRealtimeActive(localPath)) return "skipped-pending";

		// 삭제를 적용하는 vault에선 더 이상 의미 없는 _충돌/ 보류본·내편집 백업을 정리(고아 사본 방지).
		await this.conflicts.cleanupOnDelete(doc.path);
		this.loggedConflicts.delete(doc.path);

		const file = ctx.getFile(localPath);
		if (!file) return "skipped-deleted"; // 이미 없음

		// 구조적 변경 echo 차단: 이 경로의 rename/delete 이벤트를 잠시 무시
		ctx.suppressStructural(localPath);

		if (policy === "propagate-delete") {
			await ctx.deleteVaultFile(file);
			ctx.logger.ok(t("sync.applied_remote_deletion_permanent_delete", { path: localPath }));
			return "deleted";
		}

		// archive: localRoot/.deleted/ 아래로 이동 (기술문서 §15.1)
		let archivePath = ctx.archiveLocalPath(doc.path);
		if (ctx.fileExists(archivePath)) archivePath = `${archivePath}.${Date.now()}`;
		ctx.suppressStructural(archivePath);
		await ctx.renameVaultFile(file, archivePath);
		ctx.logger.ok(t("sync.applied_remote_deletion_archived_to_deleted", { from: localPath, to: archivePath }));
		return "deleted";
	}
}
