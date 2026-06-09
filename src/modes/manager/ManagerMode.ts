import { CoreServices } from "../../core/CoreServices";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { SyncDirection } from "../../core/sync/FullSync";
import { computeChildRoots } from "../../core/sync/childRoots";
import { pickSyncByDb, pickSyncOwning } from "../../core/sync/syncLookup";
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
						}),
				  ]
				: [];
		this.syncs = [...memberSyncs, ...sharedSyncs, ...personalSyncs];
		// 실시간(RealtimeManager)이 참조할 공간 목록: 공유 공간 + 실시간 허용 학생의 개인 mirror(1:1).
		// mirror 공간은 학생 폴더(localRoot)를 그대로 folder로 쓰고 spaceId=mirror-<id>로 구분한다.
		// 별도 동기화 링크는 만들지 않는다(이미 memberSyncs가 그 폴더를 동기화하므로).
		// 전역 실시간이 켜지면 모든 공유 공간과 토큰이 발급된 모든 개인 mirror가 실시간 대상.
		const mirrorSpaces = members
			.filter((st) => st.realtimeToken)
			.map((st) => ({ id: `mirror-${st.memberId}`, folder: st.localRoot, token: st.realtimeToken, kind: "mirror" as const }));
		core.sharedSpaces = [
			...shared.map((sp) => ({
				id: sp.id,
				folder: sp.folder,
				token: sp.token,
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
		for (const sync of this.syncs) await sync.start();
	}

	async stop(): Promise<void> {
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
