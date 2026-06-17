import { App, Notice, TFile, normalizePath } from "obsidian";
import { Logger } from "../core/log/Logger";
import { CoVaultSettings } from "../settings/types";
import { MirrorSync } from "../core/sync/MirrorSync";
import { dbPathOfId } from "../core/sync/orphanRepair";
import { detectPeriodicRepeat } from "../core/sync/dedupRepeat";
import { ensureParentFolders } from "../core/vault/folders";
import { errMessage } from "../core/util/err";
import { confirm } from "../ui/ConfirmModal";
import { t } from "../i18n";

/**
 * 공유 공간 정합 복구(교사 전용). 로컬 DB엔 살아있지만 내 vault엔 없는 공유 파일을 tombstone해 전파한다 —
 * 폴더 삭제가 전파되지 않아(폴더 삭제 이벤트 누락 버그) 구성원 vault에 남은 잔존 파일을 정리한다.
 * 공유 공간 링크만 대상으로 한다(구성원 mirror·개인 동기화 제외 — 거긴 내 vault가 정본이 아니라
 * 아직 안 받은 파일을 고아로 오인해 지울 수 있다). 개수·경로 확인 후 실행.
 *
 * 연결 확보: 관리자 링크가 많으면(>6) 라이브 longpoll이 Chromium 호스트당 연결 한도를 채워 복구의 pull/push가
 * 굶는다(requestUrl은 취소 불가라 잡힌 연결이 ~60s 하트비트로만 풀림). 그래서 pull·push 구간 동안 전 링크
 * 복제를 잠시 멈춰 연결을 비우고(끝나면 되살림) pull 타임아웃을 넉넉히 둔다. 모든 단계를 로그로 남긴다.
 */
export interface RepairDeps {
	app: App;
	logger: Logger;
	settings(): CoVaultSettings;
	getSyncs(): MirrorSync[];
	/** 공동 공간 폴더(개인 mirror 제외). 중복 누적 정리 대상. */
	sharedFolders(): string[];
	openLog(): Promise<void>;
}

/** 중복 누적 정리 후보(노트 전체 내용이 정확 k회 반복). */
interface DedupCandidate {
	file: TFile;
	folder: string;
	rel: string;
	before: number;
	after: number;
	copies: number;
	unit: string;
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

	/** 전 링크 복제를 멈춰 연결을 비운 상태로 fn을 실행하고, 끝나면 복제를 되살린다. */
	private async withConnectionsFreed<T>(allSyncs: MirrorSync[], fn: () => Promise<T>): Promise<T> {
		for (const sync of allSyncs) sync.pauseReplication();
		try {
			return await fn();
		} finally {
			for (const sync of allSyncs) sync.resumeReplication();
		}
	}

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

		// 1단계: 원격 _all_docs를 직접 조회(연결 비운 상태)해 고아 문서 id를 찾는다. 로컬 체크포인트가 뒤처져도
		// 원격 실제 상태 기준이라 옛 삭제 파일/유령 문서(vault엔 없는데 DB엔 live)를 잡는다.
		const found = await this.withConnectionsFreed(allSyncs, async () => {
			const acc: Array<{ sync: MirrorSync; ids: string[] }> = [];
			for (const sync of syncs) {
				this.d.logger.info(t("sync.repair_pulling", { db: sync.remoteDb }), true);
				const scan = await withTimeout(sync.scanRemoteOrphans(), 75000, () => null);
				if (!scan) {
					this.d.logger.warn(t("sync.repair_pull_failed", { db: sync.remoteDb, err: "timeout/error" }), true);
					continue;
				}
				this.d.logger.info(t("sync.repair_scanned", { db: sync.remoteDb, live: scan.liveCount, orphans: scan.ids.length }), true);
				if (scan.ids.length > 0) acc.push({ sync, ids: scan.ids });
			}
			return acc;
		});

		const total = found.reduce((n, f) => n + f.ids.length, 0);
		if (total === 0) {
			this.d.logger.ok(t("sync.repair_consistency_ok"), true);
			return;
		}
		const sample = found.flatMap((f) => f.ids.map(dbPathOfId)).slice(0, 12).join("\n");
		const ok = await confirm(this.d.app, {
			title: t("sync.repair_confirm_title"),
			message: t("sync.repair_confirm_body", { n: total, sample }),
			confirmText: t("common.delete"),
			warning: true,
		});
		if (!ok) return;

		// 2단계: 원격에 직접 tombstone(원격 rev 위에) → live 분기를 확실히 덮어 다시 안 살아나게 + 전파.
		const tombstoned = await this.withConnectionsFreed(allSyncs, async () => {
			let n = 0;
			for (const f of found) {
				n += await f.sync.tombstoneRemoteOrphans(f.ids).catch((e) => {
					this.d.logger.warn(t("sync.repair_pull_failed", { db: f.sync.remoteDb, err: errMessage(e) }), true);
					return 0;
				});
			}
			return n;
		});
		this.d.logger.ok(t("sync.repair_done", { n: tombstoned }), true);
	}

	/** 경로가 folder 아래인가(folder 자신 제외 — 하위만). */
	private under(path: string, folder: string): boolean {
		return path === folder || path.startsWith(folder + "/");
	}

	/** 공유 폴더 아래 markdown을 훑어 정확 주기 반복(오염) 후보를 모은다. */
	private async scanDuplicates(folders: string[]): Promise<DedupCandidate[]> {
		const s = this.d.settings();
		const out: DedupCandidate[] = [];
		for (const file of this.d.app.vault.getMarkdownFiles()) {
			const folder = folders.find((f) => this.under(file.path, f));
			if (!folder) continue;
			const rel = file.path.slice(folder.length + 1);
			// 보관·충돌 폴더는 정본 대상이 아니다(백업 사본이 다시 탐지되는 것도 막는다).
			if (this.under(rel, s.archiveFolder) || this.under(rel, s.conflictFolder)) continue;
			// excalidraw(.excalidraw.md)는 JSON 그림이라 반복 축소 위험 — 제외.
			if (file.path.toLowerCase().endsWith(".excalidraw.md")) continue;
			const content = await this.d.app.vault.cachedRead(file);
			const hit = detectPeriodicRepeat(content);
			if (hit) out.push({ file, folder, rel, before: content.length, after: hit.unit.length, copies: hit.copies, unit: hit.unit });
		}
		return out;
	}

	/** 원본을 공유 폴더의 충돌 폴더(동기화 제외)에 백업. 경로 충돌은 타임스탬프로 회피. */
	private async backupBeforeCollapse(c: DedupCandidate): Promise<void> {
		const conflict = this.d.settings().conflictFolder;
		const flat = c.rel.replace(/\//g, "_");
		const path = normalizePath(`${c.folder}/${conflict}/dedup/${flat}.${Date.now()}.bak.md`);
		await ensureParentFolders(this.d.app, path);
		const original = await this.d.app.vault.read(c.file);
		await this.d.app.vault.adapter.write(path, original);
	}

	/**
	 * 중복 누적(ABCABC) 노트 정리(멱등·역할 무관). 실시간 절전-재접속 레이스가 남긴 '전체 내용 정확 k회 반복'을
	 * 단위 1개로 축소한다 — 내용 기반 탐지만이 stale 재전송과 오염을 구분한다(시각·버전·rev로는 불가: 재전송이
	 * 늘 '최신 쓰기'로 위장). [dedupRepeat] 참고. 탐지→목록 확인→백업 후 정본으로 덮기. vault 쓰기는
	 * LocalWatcher가 업로드해 전파 → 모든 볼트가 수렴. 어느 볼트든 오염본이 남으면 재전송하므로 각 볼트에서 실행.
	 */
	async cleanupDuplicates(): Promise<void> {
		await this.d.openLog();
		const folders = this.d.sharedFolders();
		this.d.logger.info(t("dedup.scan_started", { n: folders.length }), true);
		if (folders.length === 0) {
			this.d.logger.warn(t("dedup.no_shared_folders"), true);
			return;
		}
		let candidates: DedupCandidate[];
		try {
			candidates = await this.scanDuplicates(folders);
		} catch (e) {
			this.d.logger.error(t("dedup.scan_failed", { err: errMessage(e) }), true);
			return;
		}
		if (candidates.length === 0) {
			this.d.logger.ok(t("dedup.none_found"), true);
			return;
		}
		const sample = candidates
			.slice(0, 12)
			.map((c) => t("dedup.sample_line", { path: `${c.folder}/${c.rel}`, copies: c.copies, before: c.before, after: c.after }))
			.join("\n");
		const ok = await confirm(this.d.app, {
			title: t("dedup.confirm_title"),
			message: t("dedup.confirm_body", { n: candidates.length, sample }),
			confirmText: t("dedup.confirm_action"),
			warning: true,
		});
		if (!ok) return;
		let cleaned = 0;
		for (const c of candidates) {
			try {
				// 스캔 이후 바뀌었을 수 있으니 최신 내용으로 재검증(멱등·레이스 안전).
				const fresh = await this.d.app.vault.read(c.file);
				const hit = detectPeriodicRepeat(fresh);
				if (!hit) continue;
				await this.backupBeforeCollapse(c);
				await this.d.app.vault.process(c.file, () => hit.unit);
				cleaned++;
				this.d.logger.ok(t("dedup.cleaned_one", { path: `${c.folder}/${c.rel}`, copies: hit.copies }));
			} catch (e) {
				this.d.logger.warn(t("dedup.clean_failed_one", { path: `${c.folder}/${c.rel}`, err: errMessage(e) }), true);
			}
		}
		new Notice(t("dedup.done", { n: cleaned }));
		this.d.logger.ok(t("dedup.done", { n: cleaned }), true);
	}
}
