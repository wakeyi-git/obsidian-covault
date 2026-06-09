import { CoreServices } from "../../core/CoreServices";
import { errMessage } from "../../core/util/err";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { SyncDirection } from "../../core/sync/FullSync";
import { computeChildRoots } from "../../core/sync/childRoots";
import { pickSyncByDb, pickSyncOwning } from "../../core/sync/syncLookup";
import { SharesDoc, SHARES_DOC_ID, RtConfigDoc, RTCONFIG_DOC_ID } from "../../core/model/types";
import { CoVaultMode } from "../CoVaultMode";
import { t } from "../../i18n";

/**
 * Member Mode (Phase 6a). 기술문서 §11.
 * 개인 미러(vault ↔ 자기 mirror DB) + 교사가 배정한 공유 공간(모둠/학급) 링크를 동기화한다.
 * 공유 공간 목록은 개인 mirror DB의 'shares' 문서로 자동 전파되며, 변경 시 reconcile한다.
 */
export class MemberMode implements CoVaultMode {
	readonly role = "member" as const;
	private syncs: MirrorSync[] = [];
	private reconciling = false;
	private pendingReconcile = false;

	constructor(private core: CoreServices) {}

	async start(): Promise<void> {
		await this.reconcile();
	}

	async stop(): Promise<void> {
		for (const sync of this.syncs) await sync.stop();
		this.syncs = [];
		this.core.logger.info(t("mode.member_mode_stopped"));
	}

	async fullSync(direction: SyncDirection): Promise<void> {
		for (const sync of this.syncs) await sync.fullSync(direction);
	}

	getSyncs(): MirrorSync[] {
		return this.syncs;
	}

	findSyncByDb(db: string): MirrorSync | undefined {
		return pickSyncByDb(this.syncs, db);
	}

	findSyncOwning(localPath: string): MirrorSync | undefined {
		return pickSyncOwning(this.syncs, localPath);
	}

	/** 공유 공간 변경(또는 수동 새로고침) 시 링크 재구성. */
	async refreshShares(): Promise<void> {
		await this.reconcile();
	}

	// --- 내부 ---

	private async reconcile(): Promise<void> {
		if (this.reconciling) {
			this.pendingReconcile = true;
			return;
		}
		this.reconciling = true;
		try {
			const s = this.core.settings;
			await this.applyRtConfig(); // 교사가 배포한 실시간 설정 수신
			const spaces = await this.readShares();
			// 실시간(RealtimeManager)은 realtime!==false인 공간만(mirror는 항상 실시간 용도). 파일 동기화와 무관.
			this.core.sharedSpaces = spaces
				.filter((sp) => sp.kind === "mirror" || sp.realtime !== false)
				.map((sp) => ({ id: sp.id, folder: sp.folder, token: sp.token, kind: sp.kind }));
			// 학급 공동 공간 지정 수신 — 알림장·수업안내·과제 공유의 기준 폴더/DB.
			const hr = spaces.find((sp) => sp.kind === "homeroom");
			this.core.homeroom = hr ? { remoteDb: hr.remoteDb, folder: hr.folder } : null;
			// 동기화 링크는 공유 공간(kind!=="mirror")만 만든다 — mirror는 개인 mirror로 이미 동기화되므로 중복 금지.
			// 실시간 on/off와 무관하게 모든 공유 공간을 동기화한다.
			const linkSpaces = spaces.filter((sp) => sp.kind !== "mirror");
			const sharedFolders = linkSpaces.map((sp) => sp.folder);
			const allRoots = [s.localRoot, ...sharedFolders];

			// 기존 링크 중지 후 재구성
			for (const sync of this.syncs) await sync.stop();
			this.syncs = [];

			// 개인 미러 (공유 폴더는 childRoots로 제외)
			this.syncs.push(
				new MirrorSync(this.core, {
					memberId: s.userId,
					memberName: s.displayName,
					localRoot: s.localRoot,
					remoteDb: s.remoteDb,
					childRoots: computeChildRoots(s.localRoot, allRoots),
					onConfigChange: () => this.scheduleReconcile(),
				}),
			);

			// 공유 공간 (학생 본인 자격, _security로 접근 허용됨). mirror 공간은 제외(개인 mirror가 담당).
			for (const sp of linkSpaces) {
				this.syncs.push(
					new MirrorSync(this.core, {
						memberId: s.userId,
						memberName: sp.name,
						localRoot: sp.folder,
						remoteDb: sp.remoteDb,
						childRoots: computeChildRoots(sp.folder, allRoots),
					}),
				);
			}

			for (const sync of this.syncs) await sync.start();
			this.core.logger.ok(t("mode.member_mode_started_personal_shared", { count: linkSpaces.length }), true);
		} catch (e) {
			this.core.logger.error(
				t("mode.failed_to_reconcile_shared_spaces", { error: errMessage(e) }),
				true,
			);
		} finally {
			this.reconciling = false;
			if (this.pendingReconcile) {
				this.pendingReconcile = false;
				this.scheduleReconcile();
			}
		}
	}

	private scheduleReconcile(): void {
		// 콜백 재진입 방지: 다음 틱에 reconcile
		setTimeout(() => void this.reconcile(), 100);
	}

	/** 개인 mirror DB(로컬)에서 shares 문서를 읽는다. 없으면 빈 목록. */
	private async readShares(): Promise<SharesDoc["spaces"]> {
		const pouch = this.core.createPouch(this.core.settings.remoteDb);
		try {
			const doc = await pouch.get<SharesDoc>(SHARES_DOC_ID);
			return doc?.spaces ?? [];
		} catch {
			return [];
		} finally {
			await pouch.close();
		}
	}

	/** 교사가 배포한 rtconfig(실시간 서버/스냅샷 주기)를 받아 설정에 반영. 실시간 인증은 shares의 공간별 HMAC 토큰을 사용. */
	private async applyRtConfig(): Promise<void> {
		const pouch = this.core.createPouch(this.core.settings.remoteDb);
		try {
			const doc = await pouch.get<RtConfigDoc>(RTCONFIG_DOC_ID);
			if (!doc) return;
			const s = this.core.settings;
			const snapshotSec = doc.snapshotSec ?? 0;
			const readOnly = !!doc.sharedReadOnly;
			if (s.realtimeEnabled !== doc.enabled || s.yjsServerUrl !== doc.url || s.realtimeSnapshotSec !== snapshotSec || !!s.sharedReadOnly !== readOnly) {
				s.realtimeEnabled = doc.enabled;
				s.yjsServerUrl = doc.url;
				s.realtimeSnapshotSec = snapshotSec;
				s.sharedReadOnly = readOnly;
				await this.core.save();
			}
		} catch {
			/* 없으면 무시 */
		} finally {
			await pouch.close();
		}
	}
}
