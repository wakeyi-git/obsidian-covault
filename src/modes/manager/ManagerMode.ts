import { CoreServices } from "../../core/CoreServices";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { SyncDirection } from "../../core/sync/FullSync";
import { computeChildRoots } from "../../core/sync/childRoots";
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

		const memberSyncs = members.map(
			(st) =>
				new MirrorSync(core, {
					memberId: st.memberId,
					memberName: st.memberName,
					localRoot: st.localRoot,
					remoteDb: st.remoteDb,
					childRoots: computeChildRoots(st.localRoot, roots),
				}),
		);
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
		this.syncs = [...memberSyncs, ...sharedSyncs];
		// 실시간(RealtimeManager)이 참조할 공간 목록: 공유 공간 + 실시간 허용 학생의 개인 mirror(1:1).
		// mirror 공간은 학생 폴더(localRoot)를 그대로 folder로 쓰고 spaceId=mirror-<id>로 구분한다.
		// 별도 동기화 링크는 만들지 않는다(이미 memberSyncs가 그 폴더를 동기화하므로).
		const mirrorSpaces = members
			.filter((st) => st.realtime && st.realtimeToken)
			.map((st) => ({ id: `mirror-${st.memberId}`, folder: st.localRoot, token: st.realtimeToken, kind: "mirror" as const }));
		core.sharedSpaces = [
			// 공유 공간은 realtime!==false인 것만 실시간 대상(파일 동기화 링크는 위에서 별도로 모두 구성됨).
			...shared
				.filter((sp) => sp.realtime !== false)
				.map((sp) => ({ id: sp.id, folder: sp.folder, token: sp.token, kind: "share" as const })),
			...mirrorSpaces,
		];
	}

	async start(): Promise<void> {
		const s = this.core.settings;
		this.core.logger.ok(
			t("mode.teacher_mode_started_students_shared", {
				members: s.members.length,
				shared: s.sharedSpaces.length,
			}),
			true,
		);
		if (this.syncs.length === 0) {
			this.core.logger.warn(t("mode.no_students_or_shared_spaces_add"));
			return;
		}
		for (const sync of this.syncs) await sync.start();
	}

	async stop(): Promise<void> {
		for (const sync of this.syncs) await sync.stop();
		this.core.logger.info(t("mode.teacher_mode_stopped"));
	}

	async fullSync(direction: SyncDirection): Promise<void> {
		for (const sync of this.syncs) await sync.fullSync(direction);
	}

	getSyncs(): MirrorSync[] {
		return this.syncs;
	}
}
