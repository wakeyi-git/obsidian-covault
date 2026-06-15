import { App, Notice } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings } from "../settings/types";
import { MirrorSync } from "../core/sync/MirrorSync";
import { errMessage } from "../core/util/err";
import { confirm } from "../ui/ConfirmModal";
import { t } from "../i18n";

/**
 * 공유 공간 정합 복구(교사 전용). 로컬 DB엔 살아있지만 내 vault엔 없는 공유 파일을 tombstone해 전파한다 —
 * 폴더 삭제가 전파되지 않아(폴더 삭제 이벤트 누락 버그) 구성원 vault에 남은 잔존 파일을 정리한다.
 * 공유 공간 링크만 대상으로 한다(구성원 mirror·개인 동기화 제외 — 거긴 내 vault가 정본이 아니라
 * 아직 안 받은 파일을 고아로 오인해 지울 수 있다). 개수·경로 확인 후 실행.
 *
 * 모든 단계를 로그로 남기고 pull에 타임아웃을 둔다 — pull이 멈춰도(연결 고갈 등) 복구가 얼어붙지 않고
 * 무엇이 일어났는지 보이게 한다("실행해도 아무 로그도 안 뜬다"를 방지).
 */
export interface RepairDeps {
	app: App;
	logger: Logger;
	settings(): CoVaultSettings;
	getSyncs(): MirrorSync[];
	openLog(): Promise<void>;
}

/** 멈춤 방지: p가 ms 안에 끝나지 않으면 onTimeout 값으로 진행. 거부도 onTimeout으로 흡수. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
	return new Promise<T>((resolve) => {
		const timer = setTimeout(() => resolve(onTimeout()), ms);
		p.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			() => {
				clearTimeout(timer);
				resolve(onTimeout());
			},
		);
	});
}

export class RepairController {
	constructor(private d: RepairDeps) {}

	async repairSharedConsistency(): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") {
			new Notice(t("command.available_in_manager_mode_only"));
			return;
		}
		await this.d.openLog();
		const allSyncs = this.d.getSyncs();
		const sharedDbs = new Set(s.sharedSpaces.map((sp) => sp.remoteDb).filter(Boolean));
		const syncs = allSyncs.filter((x) => sharedDbs.has(x.remoteDb));
		this.d.logger.info(t("sync.repair_started", { shared: syncs.length, total: allSyncs.length }), true);
		if (syncs.length === 0) {
			this.d.logger.warn(t("sync.repair_no_shared_spaces"), true);
			return;
		}
		const found: Array<{ sync: MirrorSync; paths: string[] }> = [];
		for (const sync of syncs) {
			// 원격을 먼저 pull해 로컬 DB를 최신(구성원이 보는 상태)과 맞춘다. 관리자가 쓴 파일은 skip-self라
			// pull해도 vault에 되살아나지 않으므로, vault엔 없고 DB엔 live인 고아로 정확히 잡힌다.
			this.d.logger.info(t("sync.repair_pulling", { db: sync.remoteDb }));
			const pulled = await withTimeout(sync.pullOnce(), 20000, () => -1);
			if (pulled < 0) this.d.logger.warn(t("sync.repair_pull_failed", { db: sync.remoteDb, err: "timeout/error" }), true);
			const scan = await sync.scanVaultOrphans();
			this.d.logger.info(t("sync.repair_scanned", { db: sync.remoteDb, live: scan.liveCount, orphans: scan.orphans.length }), true);
			if (scan.orphans.length > 0) found.push({ sync, paths: scan.orphans });
		}
		const total = found.reduce((n, f) => n + f.paths.length, 0);
		if (total === 0) {
			this.d.logger.ok(t("sync.repair_consistency_ok"), true);
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
		for (const f of found) tombstoned += await f.sync.tombstoneVaultOrphans(f.paths).catch((e) => {
			this.d.logger.warn(t("sync.repair_pull_failed", { db: f.sync.remoteDb, err: errMessage(e) }));
			return 0;
		});
		this.d.logger.ok(t("sync.repair_done", { n: tombstoned }), true);
	}
}
