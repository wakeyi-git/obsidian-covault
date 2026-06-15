import { App, Notice } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings } from "../settings/types";
import { MirrorSync } from "../core/sync/MirrorSync";
import { confirm } from "../ui/ConfirmModal";
import { t } from "../i18n";

/**
 * 공유 공간 정합 복구(교사 전용). 로컬 DB엔 살아있지만 내 vault엔 없는 공유 파일을 tombstone해 전파한다 —
 * 폴더 삭제가 전파되지 않아(폴더 삭제 이벤트 누락 버그) 구성원 vault에 남은 잔존 파일을 정리한다.
 * 공유 공간 링크만 대상으로 한다(구성원 mirror·개인 동기화 제외 — 거긴 내 vault가 정본이 아니라
 * 아직 안 받은 파일을 고아로 오인해 지울 수 있다). 개수·경로 확인 후 실행.
 */
export interface RepairDeps {
	app: App;
	logger: Logger;
	settings(): CoVaultSettings;
	getSyncs(): MirrorSync[];
	openLog(): Promise<void>;
}

export class RepairController {
	constructor(private d: RepairDeps) {}

	async repairSharedConsistency(): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") {
			new Notice(t("command.available_in_manager_mode_only"));
			return;
		}
		const sharedDbs = new Set(s.sharedSpaces.map((sp) => sp.remoteDb).filter(Boolean));
		const syncs = this.d.getSyncs().filter((x) => sharedDbs.has(x.remoteDb));
		if (syncs.length === 0) {
			new Notice(t("sync.repair_no_shared_spaces"));
			return;
		}
		await this.d.openLog();
		// 원격을 먼저 pull해 로컬 DB를 최신(구성원이 보는 상태)과 맞춘다 — 관리자 로컬 DB가 뒤처져
		// "고아 없음"으로 잘못 나오던 경우를 없앤다. 관리자가 쓴 파일은 skip-self라 vault에 되살아나지 않는다.
		for (const sync of syncs) await sync.pullOnce().catch(() => 0);
		const found: Array<{ sync: MirrorSync; paths: string[] }> = [];
		for (const sync of syncs) {
			const scan = await sync.scanVaultOrphans();
			this.d.logger.info(t("sync.repair_scanned", { db: sync.remoteDb, live: scan.liveCount, orphans: scan.orphans.length }));
			if (scan.orphans.length > 0) found.push({ sync, paths: scan.orphans });
		}
		const total = found.reduce((n, f) => n + f.paths.length, 0);
		if (total === 0) {
			new Notice(t("sync.repair_consistency_ok"));
			return;
		}
		const sample = found.flatMap((f) => f.paths).slice(0, 12).join("\n");
		const ok = await confirm(this.d.app, {
			title: t("sync.repair_confirm_title"),
			message: t("sync.repair_confirm_body", { n: total, sample }),
			confirmText: t("common.delete"),
			warning: true,
		});
		if (!ok) return;
		let tombstoned = 0;
		for (const f of found) tombstoned += await f.sync.tombstoneVaultOrphans(f.paths);
		this.d.logger.ok(t("sync.repair_done", { n: tombstoned }), true);
	}
}
