import { App, TFile } from "obsidian";
import { Logger } from "../core/log/Logger";
import { MirrorSync } from "../core/sync/MirrorSync";
import { ConflictRow } from "../ui/ConflictModal";
import { ResolveChoice } from "../core/sync/ConflictManager";
import { DashboardRow, DeleteModifyRow, PurgeRow } from "../ui/panel/PanelSection";
import { DeletedItem, RestoreResult, RestoreOptions, DeleteModifyChoice } from "../core/sync/RestoreManager";
import { VersionDoc } from "../core/model/types";
import { errMessage } from "../core/util/err";
import { t } from "../i18n";

/**
 * 복구·충돌·동기화 상태 집계 컨트롤러. main.ts에 흩어져 있던 "전 sync 순회→집계" + "remoteDb로 찾아 위임"
 * 패턴을 한곳에 모은다(거동 동일). 설정 변경은 없고 동기화 링크 조회/위임만 한다.
 */
export interface RecoveryDeps {
	app: App;
	logger: Logger;
	getSyncs(): MirrorSync[];
	findSyncByDb(db: string): MirrorSync | undefined;
	findSyncOwning(localPath: string): MirrorSync | undefined;
	openLog(): Promise<void>;
}

export class RecoveryController {
	constructor(private d: RecoveryDeps) {}

	// --- 충돌 (ConflictHost) ---
	async listConflicts(): Promise<ConflictRow[]> {
		const rows: ConflictRow[] = [];
		for (const sync of this.d.getSyncs()) {
			try {
				const infos = await sync.listConflicts();
				for (const info of infos) rows.push({ sync, info });
			} catch (e) {
				this.d.logger.error(t("command.failed_to_fetch_conflict_list", { label: sync.label, err: errMessage(e) }));
			}
		}
		return rows;
	}

	async resolveConflict(row: ConflictRow, choice: ResolveChoice): Promise<void> {
		await this.d.openLog();
		await row.sync.resolveConflict(row.info.dbPath, choice);
	}

	/**
	 * 충돌 일괄 해소 — 넘겨받은 행을 모두 같은 선택지로 처리한다. 한 건 실패가 나머지를 막지 않도록
	 * 행마다 격리해 진행하고(성공/실패 집계 반환), 첨부에 무효한 "both-remote"는 "both"로 강등한다.
	 */
	async resolveAllConflicts(rows: ConflictRow[], choice: ResolveChoice): Promise<{ resolved: number; failed: number }> {
		await this.d.openLog();
		let resolved = 0;
		let failed = 0;
		for (const row of rows) {
			const c: ResolveChoice = choice === "both-remote" && row.info.kind === "asset" ? "both" : choice;
			try {
				await row.sync.resolveConflict(row.info.dbPath, c);
				resolved++;
			} catch (e) {
				failed++;
				this.d.logger.error(t("conflict.resolution_failed", { error: errMessage(e) }) + ` (${row.info.dbPath})`);
			}
		}
		return { resolved, failed };
	}

	async openConflictFiles(row: ConflictRow): Promise<void> {
		const local = this.d.app.vault.getAbstractFileByPath(row.info.localPath);
		const conflict = this.d.app.vault.getAbstractFileByPath(row.info.conflictPath);
		if (local instanceof TFile) await this.d.app.workspace.getLeaf(false).openFile(local);
		if (conflict instanceof TFile) await this.d.app.workspace.getLeaf("split").openFile(conflict);
		else this.d.logger.warn(t("command.remote_copy_file_not_found", { path: row.info.conflictPath }), true);
	}

	// --- 동기화 상태 ---
	async getDashboardRows(): Promise<DashboardRow[]> {
		const rows: DashboardRow[] = [];
		for (const sync of this.d.getSyncs()) {
			// 증분 집계(평가 P-1) — 5초 폴링이 링크별 전 문서를 본문 포함으로 적재하지 않는다.
			const conflicts = sync.conflictCount();
			rows.push({
				memberName: sync.memberName,
				memberId: sync.memberId,
				remoteDb: sync.remoteDb,
				localRoot: sync.localRoot,
				conflicts,
				...sync.status,
			});
		}
		return rows;
	}

	// --- 삭제 파일 복구 ---
	async listDeletedFiles(): Promise<DeletedItem[]> {
		const out: DeletedItem[] = [];
		for (const sync of this.d.getSyncs()) {
			try {
				out.push(...(await sync.listDeleted()));
			} catch {
				/* 조회 실패한 링크는 건너뜀 */
			}
		}
		return out;
	}

	restoreDeleted(remoteDb: string, dbPath: string, opts?: RestoreOptions): Promise<RestoreResult> {
		const sync = this.d.findSyncByDb(remoteDb);
		if (!sync) return Promise.resolve("unrecoverable" as RestoreResult);
		return sync.restoreDeleted(dbPath, opts);
	}

	purgeDeleted(remoteDb: string, dbPath: string): Promise<"purged" | "skipped"> {
		const sync = this.d.findSyncByDb(remoteDb);
		if (!sync) return Promise.resolve("skipped");
		return sync.purgeDeleted(dbPath);
	}

	async listDeleteModify(): Promise<DeleteModifyRow[]> {
		const out: DeleteModifyRow[] = [];
		for (const sync of this.d.getSyncs()) {
			try {
				for (const it of await sync.listDeleteModify()) {
					out.push({ ...it, remoteDb: sync.remoteDb, memberName: sync.memberName });
				}
			} catch {
				/* 조회 실패 링크 건너뜀 */
			}
		}
		return out;
	}

	resolveDeleteModify(remoteDb: string, dbPath: string, choice: DeleteModifyChoice): Promise<void> {
		const sync = this.d.findSyncByDb(remoteDb);
		return sync ? sync.resolveDeleteModify(dbPath, choice) : Promise.resolve();
	}

	async listRecentPurges(): Promise<PurgeRow[]> {
		const out: PurgeRow[] = [];
		for (const sync of this.d.getSyncs()) {
			try {
				for (const p of await sync.listRecentPurges()) {
					out.push({ ...p, remoteDb: sync.remoteDb, memberName: sync.memberName });
				}
			} catch {
				/* 조회 실패 링크 건너뜀 */
			}
		}
		return out;
	}

	undoPurge(remoteDb: string, id: string): Promise<RestoreResult> {
		const sync = this.d.findSyncByDb(remoteDb);
		return sync ? sync.undoPurge(id) : Promise.resolve("unrecoverable" as RestoreResult);
	}

	clearPurge(remoteDb: string, id: string): Promise<void> {
		const sync = this.d.findSyncByDb(remoteDb);
		return sync ? sync.clearPurge(id) : Promise.resolve();
	}

	// --- 버전 히스토리 ---
	async versionHistoryFor(localPath: string): Promise<VersionDoc[]> {
		const sync = this.d.findSyncOwning(localPath);
		if (!sync) return [];
		const dbPath = sync.ctx.toDbPath(localPath);
		return dbPath ? sync.listVersions(dbPath) : [];
	}

	restoreVersion(localPath: string, versionDocId: string, opts: { backupCurrent?: boolean }): Promise<"restored" | "missing"> {
		const sync = this.d.findSyncOwning(localPath);
		return sync ? sync.restoreVersion(versionDocId, opts) : Promise.resolve("missing");
	}
}
