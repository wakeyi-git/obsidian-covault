import { CoreServices } from "../../core/CoreServices";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { SyncDirection } from "../../core/sync/FullSync";
import { computeChildRoots } from "../../core/sync/childRoots";
import { pickSyncByDb, pickSyncOwning } from "../../core/sync/syncLookup";
import { DbUpdatesWatcher } from "../../core/couch/DbUpdatesWatcher";
import { chooseTransport } from "../../core/couch/dbUpdatesLogic";
import { getCouchPassword, getBearerToken, spaceTokenId, memberMirrorTokenId, managerMirrorTokenId } from "../../core/secret";
import { CoVaultMode } from "../CoVaultMode";
import { t } from "../../i18n";

/**
 * Manager Mode (Phase 2 + 6a). 기술문서 §12.
 * 학생 폴더 1:1 미러 + 공유 공간(모둠/학급) 링크를 동시에 동기화한다.
 * 교사 자격증명은 서버 admin이라 모든 DB에 접근한다.
 */
export class ManagerMode implements CoVaultMode {
	readonly role = "manager" as const;
	private readonly syncs: MirrorSync[];
	// --- 통합 변경 감지(_db_updates, 평가 H-6) — 옵션·probe 성공 시 live 대신 이벤트 구동 ---
	private watcher: DbUpdatesWatcher | null = null;
	private safetyTimer: ReturnType<typeof setInterval> | null = null;
	private transport: "live" | "event" = "live";

	constructor(private core: CoreServices) {
		const s = core.settings;
		// 프로비저닝된(서버에 DB/계정이 존재하는) 항목만 동기화. 미초대·초기화된 항목은 제외
		// → 빈 학생으로 잘못된 링크가 생기거나, 삭제된 DB로 replication이 무한 재시도되는 것을 막는다.
		const members = s.members.filter((st) => st.provisioned && st.memberId && st.remoteDb && st.localRoot);
		const shared = s.sharedSpaces.filter((sp) => sp.provisioned && sp.remoteDb && sp.folder);

		// 모든 링크의 localRoot(개인 학생 폴더 + 공유 폴더)로 겹침 제외 계산
		const roots = [...members.map((st) => st.localRoot), ...shared.map((sp) => sp.folder)];

		const memberSyncs = members.map((st) => {
			// 공동 공간 파일이 구성원 개인 미러로 새어 들어간 경우(구성원 vault의 공유 폴더), 교사 측 구성원 폴더
			// 아래(<localRoot>/<공유폴더>)로 펼치지 않도록 제외한다. 공유 폴더는 share_* 링크가 담당하므로 중복 방지.
			const foreignShared = shared.map((sp) => [st.localRoot, sp.folder].filter(Boolean).join("/"));
			return new MirrorSync(core, {
				memberId: st.memberId,
				memberName: st.memberName,
				localRoot: st.localRoot,
				remoteDb: st.remoteDb,
				childRoots: [...computeChildRoots(st.localRoot, roots), ...foreignShared],
				transport: () => this.transport, // start()에서 probe 후 확정 — getter라 생성 시점 미정이어도 안전
			});
		});
		const sharedSyncs = shared.map(
			(sp) =>
				new MirrorSync(core, {
					memberId: `(공유)${sp.name}`,
					memberName: sp.name,
					localRoot: sp.folder,
					remoteDb: sp.remoteDb,
					childRoots: computeChildRoots(sp.folder, roots),
					transport: () => this.transport,
				}),
		);
		// 내 볼트 개인 동기화(선택): vault 전체(localRoot="") ↔ 개인 DB. 개별/공동 공간 폴더는 childRoots로,
		// .obsidian·.trash·보관/충돌 폴더는 isExcluded(excludeFolders)로 제외된다.
		const personalSyncs =
			s.personalSyncEnabled && s.personalRemoteDb
				? [
						new MirrorSync(core, {
							memberId: t("mode.personal_vault"),
							memberName: s.displayName || t("mode.personal_vault"),
							localRoot: "",
							remoteDb: s.personalRemoteDb,
							childRoots: computeChildRoots("", roots),
							transport: () => this.transport,
						}),
				  ]
				: [];
		this.syncs = [...memberSyncs, ...sharedSyncs, ...personalSyncs];
		// 실시간(RealtimeManager)이 참조할 공간 목록: 공유 공간 + 실시간 허용 학생의 개인 mirror(1:1).
		// mirror 공간은 학생 폴더(localRoot)를 그대로 folder로 쓰고 spaceId=mirror-<id>로 구분한다.
		// 별도 동기화 링크는 만들지 않는다(이미 memberSyncs가 그 폴더를 동기화하므로).
		// 전역 실시간이 켜지면 모든 공유 공간과 토큰이 발급된 모든 개인 mirror가 실시간 대상.
		// 토큰은 Secret Storage 우선·평문 폴백으로 해석해 런타임 목록(core.sharedSpaces)에만 담는다(평가 S-1).
		const mirrorSpaces = members
			.filter((st) => st.realtimeToken || st.realtimeTokenSet)
			.map((st) => ({
				id: `mirror-${st.memberId}`,
				folder: st.localRoot,
				token:
					getBearerToken(core.app, managerMirrorTokenId(st.memberId), st.managerMirrorToken) ??
					getBearerToken(core.app, memberMirrorTokenId(st.memberId), st.realtimeToken),
				kind: "mirror" as const,
			}));
		core.sharedSpaces = [
			...shared.map((sp) => ({
				id: sp.id,
				folder: sp.folder,
				token: getBearerToken(core.app, spaceTokenId(sp.id), sp.token),
				kind: (sp.kind === "homeroom" ? "homeroom" : "share") as "homeroom" | "share",
			})),
			...mirrorSpaces,
		];
		// 학급 공동 공간 지정(있으면) — 알림장·수업안내·과제 공유의 기준 폴더/DB.
		const hr = shared.find((sp) => sp.kind === "homeroom");
		core.homeroom = hr ? { remoteDb: hr.remoteDb, folder: hr.folder } : null;
	}

	async start(): Promise<void> {
		const s = this.core.settings;
		this.core.logger.ok(
			t("mode.manager_mode_started_members_shared", {
				members: s.members.length,
				shared: s.sharedSpaces.length,
			}),
			true,
		);
		if (this.syncs.length === 0) {
			this.core.logger.warn(t("mode.no_members_or_shared_spaces_add"));
			return;
		}
		// 감지 연결을 먼저 켠 뒤 각 sync.start()의 runStartup이 그 이전 누락분을 흡수한다(공백 없음).
		await this.initTransport();
		for (const sync of this.syncs) await sync.start();
		if (this.transport === "event") this.startSafetyNet();
		void this.sweepTombstoneRetention(); // 보존 기간 경과 tombstone 정리(백그라운드, 24시간 1회)
	}

	/**
	 * tombstone 내용 보존 기간 정리(I-3) — versionMaxAgeDays와 정렬, 운영자 기기만 실행(멤버는
	 * replication으로 스트립본 수신). 버전 히스토리를 꺼둔 환경은 따를 보존 정책이 없으므로 건너뛴다.
	 */
	private async sweepTombstoneRetention(): Promise<void> {
		const s = this.core.settings;
		if (s.versionHistory === false) return;
		const now = Date.now();
		if ((s.lastTombstoneSweepAt ?? 0) > now - 24 * 60 * 60 * 1000) return;
		s.lastTombstoneSweepAt = now;
		this.core.requestPersist();
		const days = s.versionMaxAgeDays ?? 30;
		let stripped = 0;
		for (const sync of this.syncs) {
			try {
				stripped += await sync.sweepTombstoneRetention(days);
			} catch {
				/* 링크 단위 실패는 다음 주기에 재시도 */
			}
		}
		if (stripped > 0) this.core.logger.info(t("sync.tombstone_retention_stripped", { n: stripped, days }));
	}

	/** 통합 변경 감지 사용 여부 결정(probe) + watcher 기동. 실패/미지원이면 live 유지(기능 동등성). */
	private async initTransport(): Promise<void> {
		const s = this.core.settings;
		const enabled = s.managerSyncTransport === "db-updates";
		const password = getCouchPassword(this.core.app, s.password);
		const hasCreds = !!(s.couchdbUrl && s.username && password);
		let probeOk = false;
		if (enabled && hasCreds) {
			const p = await DbUpdatesWatcher.probe(s.couchdbUrl, s.username, password);
			probeOk = p.ok;
			if (!p.ok) this.core.logger.warn(t("mode.db_updates_unsupported", { status: String(p.status ?? "network") }), true);
		}
		this.transport = chooseTransport({ enabled, isManager: true, hasCreds, probeOk });
		if (this.transport !== "event") return;
		this.watcher = new DbUpdatesWatcher({
			baseUrl: s.couchdbUrl,
			username: s.username,
			password,
			dbs: () => new Set(this.syncs.map((x) => x.remoteDb)),
			onDbChanged: (db) => void this.findSyncByDb(db)?.syncOnce(),
			onFatal: (reason, detail) => this.onWatcherFatal(reason, detail),
		});
		this.watcher.start();
		this.core.logger.info(t("mode.db_updates_active", { n: this.syncs.length }));
	}

	/** 런타임 권한 회수/미지원 — 전 링크를 live replication으로 폴백(무중단 기능 동등성). */
	private onWatcherFatal(reason: "forbidden" | "unsupported", detail: string): void {
		this.core.logger.warn(t("mode.db_updates_fallback", { reason, detail }), true);
		this.watcher = null;
		this.stopSafetyNet();
		this.transport = "live";
		for (const sync of this.syncs) sync.fallbackToLive();
	}

	/** 5분 안전망 — 감지 누락(since 리셋·외부 직접 쓰기 등)의 최종 방어선. 직렬 await라 자연 스태거. */
	private startSafetyNet(): void {
		this.safetyTimer = setInterval(
			() =>
				void (async () => {
					for (const sync of this.syncs) await sync.syncOnce();
				})(),
			5 * 60_000,
		);
	}

	private stopSafetyNet(): void {
		if (this.safetyTimer) {
			clearInterval(this.safetyTimer);
			this.safetyTimer = null;
		}
	}

	/** 백그라운드 전환: 감지 연결도 함께 멈추고/재개(절전 정책 일관성). 재개 캐치업은 resumeReplication이 수행. */
	onVisibility(hidden: boolean): void {
		if (this.transport !== "event") return;
		if (hidden) {
			this.watcher?.stop();
			this.stopSafetyNet();
		} else {
			this.watcher?.start();
			this.startSafetyNet();
		}
	}

	async stop(): Promise<void> {
		this.watcher?.stop();
		this.watcher = null;
		this.stopSafetyNet();
		for (const sync of this.syncs) await sync.stop();
		this.core.logger.info(t("mode.manager_mode_stopped"));
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
}
