import { Logger } from "../core/log/Logger";
import { CoVaultSettings, SharedSpace, GroupConfig } from "../settings/types";
import { ClassroomStore } from "../core/classroom/ClassroomStore";
import { validateFolderName, uniqueGroupFolder, isValidCouchName } from "../core/path/path";
import {
	GroupRequestDoc,
	groupRequestId,
	GROUPREQUEST_ID_PREFIX,
	RosterDoc,
	ROSTER_DOC_ID,
} from "../core/model/types";
import { t } from "../i18n";

/**
 * GroupRequestController 의존성. settings는 load/import에서 교체되므로 getter로 받는다.
 * 승인 배포는 DeploymentController.deployShared에, 그룹 문서/대화방은 ClassroomController에 위임.
 * 그룹 라이프사이클(생성·삭제·세션 대화)도 이 컨트롤러가 담당한다(M-12 — main에서 이동).
 */
export interface GroupRequestDeps {
	logger: Logger;
	classroom: ClassroomStore;
	settings(): CoVaultSettings;
	homeroomReady(): boolean;
	saveSettings(): Promise<void>;
	deployShared(space: SharedSpace, opts?: { quiet?: boolean }): Promise<void>;
	/** homeroom 그룹 문서(대화방) upsert(ClassroomController.syncGroupDoc). */
	syncGroupDoc(group: GroupConfig, memberNames: Record<string, string>): Promise<void>;
	/** homeroom 그룹 문서(대화방) 삭제(ClassroomController.deleteGroupDoc). */
	deleteGroupDoc(groupId: string): Promise<void>;
	/** 그룹 대화 채널 id(ClassroomController.groupChannelFor). */
	groupChannelFor(groupId: string): string | null;
	/** 대화 탭을 특정 채널로 연다(패널 내비게이션). */
	openChat(channel: string): Promise<void>;
	/** 그룹 공간 서버 DB 삭제(ServerResetController.deleteSharedServer — stopMode 포함). */
	deleteSharedServer(space: SharedSpace): Promise<void>;
	refreshMemberShares(): Promise<void>;
	restartMode(): Promise<void>;
}

/**
 * 구성원 자율 그룹: 신청-승인 컨트롤러. 기술문서 §12.5(신규).
 *
 * 구성원은 homeroom DB에 신청 문서(grouprequest:)를 쓰고(validate가 본인 pending만 허용),
 * 교사 기기가 변경을 감지해 승인(수동 기본/자동 설정) — 승인 시 그룹 전용 SharedSpace를
 * deployShared로 프로비저닝해 "그룹 폴더 안에서만 실시간"이 공간 단위 토큰 격리로 충족된다.
 * 구성원 기기에는 학급 명단이 없어 교사가 roster 문서를 homeroom에 배포해 선택지로 쓴다.
 */
export class GroupRequestController {
	constructor(private d: GroupRequestDeps) {}

	// --- 그룹 라이프사이클(교사) — main에서 이동(M-12) ---

	/** 명명 그룹 목록(관리 UI). */
	listGroups(): GroupConfig[] {
		return this.d.settings().groups;
	}

	/** 그룹 생성/수정(교사). settings.groups upsert + homeroom 그룹 문서(대화방) 동기화. */
	async saveGroup(group: GroupConfig): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		const i = s.groups.findIndex((g) => g.id === group.id);
		if (i >= 0) s.groups[i] = group;
		else s.groups.push(group);
		await this.d.saveSettings();
		const names: Record<string, string> = {};
		for (const id of group.memberIds) {
			const m = s.members.find((x) => x.memberId === id);
			if (m?.memberName) names[id] = m.memberName;
		}
		await this.d.syncGroupDoc(group, names);
	}

	/** 그룹 삭제(교사). settings.groups 제거 + 그룹 대화방 삭제. 그룹 공간(신청-승인)이 있으면 공간도 해제. */
	async deleteGroup(id: string): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager") return;
		const g = s.groups.find((x) => x.id === id);
		s.groups = s.groups.filter((x) => x.id !== id);
		await this.d.saveSettings();
		await this.d.deleteGroupDoc(id);
		// 그룹 공간 해제: 서버 DB 삭제 → 설정 제거 → 전 구성원 shares 재전파 → 모드 재구성.
		// 각자 로컬 폴더의 파일은 남는다(데이터 보존 — 동기화·실시간만 끊긴다).
		const space = g?.spaceId ? s.sharedSpaces.find((sp) => sp.id === g.spaceId) : undefined;
		if (space) {
			await this.d.deleteSharedServer(space); // stopMode 포함
			s.sharedSpaces = s.sharedSpaces.filter((sp) => sp.id !== space.id);
			await this.d.saveSettings();
			await this.d.refreshMemberShares();
			await this.d.restartMode();
		}
	}

	/** 그룹 대화방 열기(대화 탭). */
	async openGroupChat(groupId: string): Promise<void> {
		const ch = this.d.groupChannelFor(groupId);
		if (ch) await this.d.openChat(ch);
	}

	/**
	 * 세션 참여자 명단으로 그룹 대화 열기(교사). 구성원이 정확히 일치하는 기존 그룹(명명·임시)이 있으면
	 * 재사용하고, 없으면 임시 그룹을 만들어 연다. 임시 그룹은 대화방 목록에서 삭제할 수 있다.
	 */
	async openSessionGroupChat(memberIds: string[]): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager" || !memberIds.length) return;
		const want = new Set(memberIds);
		let g = s.groups.find((x) => x.memberIds.length === want.size && x.memberIds.every((id) => want.has(id)));
		if (!g) {
			const names = memberIds.map((id) => s.members.find((m) => m.memberId === id)?.memberName || id);
			g = {
				id: `tmp${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
				name: names.join(", "),
				memberIds: [...memberIds],
				temp: true,
			};
			await this.saveGroup(g);
		}
		await this.openGroupChat(g.id);
	}

	// --- 명단(roster) — 교사 배포, 구성원 신청 UI 소스 ---

	/** 학급 명단을 homeroom에 기록(교사). 시작·승인 처리 시 호출(멱등, 변화 없으면 생략). */
	async syncRoster(): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager" || !this.d.homeroomReady()) return;
		const members = s.members
			.filter((m) => m.memberId)
			.map((m) => ({ memberId: m.memberId, name: m.memberName || m.memberId }));
		const existing = await this.d.classroom.get<RosterDoc>(ROSTER_DOC_ID);
		if (existing && JSON.stringify(existing.members) === JSON.stringify(members)) return;
		await this.d.classroom.put({
			...(existing ?? {}),
			_id: ROSTER_DOC_ID,
			type: "roster",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			members,
			updatedAtMs: Date.now(),
		} as RosterDoc);
	}

	/** 학급 명단(구성원 신청 UI용). 미수신이면 빈 배열. */
	async rosterMembers(): Promise<Array<{ memberId: string; name: string }>> {
		const doc = await this.d.classroom.get<RosterDoc>(ROSTER_DOC_ID);
		return doc?.members ?? [];
	}

	// --- 구성원: 신청 생애주기 ---

	/** 그룹 신청(구성원). 검증 실패/상한 초과 시 경고 후 false. */
	async requestGroup(input: { name: string; folder: string; memberIds: string[] }): Promise<boolean> {
		const s = this.d.settings();
		if (!this.d.homeroomReady()) {
			this.d.logger.warn(t("group.request_needs_homeroom"), true);
			return false;
		}
		const name = input.name.trim();
		const folder = input.folder.trim();
		if (!name) {
			this.d.logger.warn(t("group.name_required"), true);
			return false;
		}
		if (!validateFolderName(folder)) {
			this.d.logger.warn(t("group.request_folder_invalid"), true);
			return false;
		}
		// 본인 포함 보장 + 중복 제거.
		const memberIds = [...new Set([s.userId, ...input.memberIds])];
		const max = s.groupMaxPerMember ?? 3;
		const mine = (await this.listMyRequests()).filter((r) => r.status === "pending");
		if (mine.length >= max) {
			this.d.logger.warn(t("group.request_limit", { n: max }), true);
			return false;
		}
		const roster = new Map((await this.rosterMembers()).map((m) => [m.memberId, m.name]));
		const memberNames: Record<string, string> = {};
		for (const id of memberIds) {
			const n = id === s.userId ? s.displayName : roster.get(id);
			if (n) memberNames[id] = n;
		}
		const uid = `gr${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
		const ok = await this.d.classroom.put({
			_id: groupRequestId(uid),
			type: "grouprequest",
			schemaVersion: 1,
			workspaceId: s.workspaceId,
			requestId: uid,
			name,
			folder,
			memberIds,
			memberNames,
			byUser: s.userId,
			byUsername: s.username,
			status: "pending",
			createdAtMs: Date.now(),
		} as GroupRequestDoc);
		if (ok) this.d.logger.ok(t("group.request_sent", { name }), true);
		else this.d.logger.warn(t("group.request_failed"), true);
		return ok;
	}

	/** 내 신청 목록(구성원, 최신순). 취소(soft-delete)분 제외. */
	async listMyRequests(): Promise<GroupRequestDoc[]> {
		const s = this.d.settings();
		const docs = await this.d.classroom.listByPrefix<GroupRequestDoc>(GROUPREQUEST_ID_PREFIX);
		return docs.filter((r) => r && !r.deleted && r.byUser === s.userId).sort((a, b) => b.createdAtMs - a.createdAtMs);
	}

	/** 신청 취소(구성원 본인, pending만). */
	async cancelRequest(req: GroupRequestDoc): Promise<void> {
		const s = this.d.settings();
		if (req.byUser !== s.userId || req.status !== "pending") return;
		await this.d.classroom.put({ ...req, deleted: true } as GroupRequestDoc);
	}

	// --- 교사: 승인/거절 ---

	/** 대기 중 신청 목록(교사, 오래된 순 — 먼저 온 신청부터 처리). */
	async listPendingRequests(): Promise<GroupRequestDoc[]> {
		if (this.d.settings().role !== "manager") return [];
		const docs = await this.d.classroom.listByPrefix<GroupRequestDoc>(GROUPREQUEST_ID_PREFIX);
		return docs.filter((r) => r && !r.deleted && r.status === "pending").sort((a, b) => a.createdAtMs - b.createdAtMs);
	}

	/**
	 * 신청 승인(교사): 그룹 전용 SharedSpace 생성·배포(deployShared 재사용 — DB+멤버십+validate+토큰+shares)
	 * → 그룹(대화방 포함) 생성 → 신청 문서에 approved 기록. 배포 실패 시 신청은 pending 유지(재시도 가능).
	 */
	async approveRequest(req: GroupRequestDoc, opts?: { quiet?: boolean }): Promise<boolean> {
		const s = this.d.settings();
		if (s.role !== "manager") return false;

		// 명단 교차검증 — 신청자가 임의 id를 넣었어도 실제 구성원만 남긴다.
		const known = new Set(s.members.map((m) => m.memberId));
		const memberIds = req.memberIds.filter((id) => known.has(id));
		if (memberIds.length === 0) {
			await this.rejectRequest(req, t("group.request_reject_no_members"));
			return false;
		}

		// 폴더 유일화: 기존 공유 공간 폴더·구성원 폴더(교사 vault)와 충돌하지 않게 보정.
		const taken = [...s.sharedSpaces.map((x) => x.folder), ...s.members.map((m) => m.localRoot)].filter(Boolean);
		const folder = uniqueGroupFolder(req.folder || req.name, taken);

		const dbSuffix = req.requestId.toLowerCase().replace(/[^a-z0-9_-]/g, "");
		const remoteDb = `share_grp_${dbSuffix}`;
		if (!isValidCouchName(remoteDb)) {
			await this.rejectRequest(req, t("group.request_reject_invalid"));
			return false;
		}
		const space: SharedSpace = {
			id: `grp_${req.requestId}`,
			name: req.name,
			remoteDb,
			folder,
			members: memberIds,
			kind: "group",
		};
		s.sharedSpaces.push(space);
		await this.d.saveSettings();
		await this.d.deployShared(space, { quiet: opts?.quiet ?? true });
		if (!space.provisioned) {
			// 배포 실패 — 공간을 되돌리고 신청은 pending 유지(자격증명/서버 복구 후 재시도).
			s.sharedSpaces = s.sharedSpaces.filter((x) => x.id !== space.id);
			await this.d.saveSettings();
			this.d.logger.warn(t("group.request_deploy_failed", { name: req.name }), true);
			return false;
		}

		await this.saveGroup({
			id: req.requestId,
			name: req.name,
			memberIds,
			spaceId: space.id,
			requestedBy: req.byUser,
		});
		await this.d.classroom.put({ ...req, status: "approved", spaceId: space.id, decidedAtMs: Date.now() } as GroupRequestDoc);
		this.d.logger.ok(t("group.request_approved_log", { name: req.name, folder }), true);
		return true;
	}

	/** 신청 거절(교사). 사유는 신청자에게 표시된다. */
	async rejectRequest(req: GroupRequestDoc, reason?: string): Promise<void> {
		if (this.d.settings().role !== "manager") return;
		await this.d.classroom.put({
			...req,
			status: "rejected",
			...(reason ? { reason } : {}),
			decidedAtMs: Date.now(),
		} as GroupRequestDoc);
	}

	/**
	 * 대기 신청 처리(교사) — grouprequest 변경 감지·시작 캐치업에서 호출.
	 * 자동 승인 설정이면 순서대로 승인하고, 아니면 알림만(그룹 탭에서 수동 처리).
	 */
	async processPending(): Promise<void> {
		const s = this.d.settings();
		if (s.role !== "manager" || !this.d.homeroomReady()) return;
		const pending = await this.listPendingRequests();
		if (pending.length === 0) return;
		if (s.groupAutoApprove) {
			for (const req of pending) await this.approveRequest(req, { quiet: true });
		} else {
			this.d.logger.info(t("group.requests_waiting", { n: pending.length }), true);
		}
	}
}
