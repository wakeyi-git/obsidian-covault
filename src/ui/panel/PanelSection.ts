import { App, setIcon } from "obsidian";
import { Logger } from "../../core/log/Logger";
import { FeedbackStore } from "../../core/feedback/FeedbackStore";
import { ClassroomStore } from "../../core/classroom/ClassroomStore";
import { CoVaultSettings, SharedSpace, GroupConfig } from "../../settings/types";
import { LinkStatus } from "../../core/sync/MirrorContext";
import { DeletedItem, RestoreResult, RestoreOptions, DeleteModifyChoice } from "../../core/sync/RestoreManager";
import { PurgeSnapshot } from "../../core/sync/recentPurge";
import { DeleteModifyItem } from "../../core/sync/deleteModifyQueue";
import { VersionDoc, AssignmentDoc, AssignmentStateDoc, AssignmentGrade, RubricCriterion, RoutineDoc, RoutineStateDoc, NoticeDoc, ResponseDoc, MessageDoc, GroupRequestDoc } from "../../core/model/types";
import { CopyOptions, CopyResult, CopyPlan } from "../../modes/manager/BulkCopy";
import { PluginDeployDoc } from "../../core/model/types";
import { InstalledPlugin } from "../../core/plugindeploy/configInstall";

/** 통합 패널 탭 식별자. */
export type PanelTab = "dashboard" | "chat" | "groups" | "feedback" | "realtime" | "deploy" | "system";
/** 시스템 탭의 서브뷰(동기화·복구·이력·로그). */
export type SystemView = "sync" | "recovery" | "history" | "log";

/** 동기화 상태 표 한 행(링크별). */
export interface DashboardRow extends LinkStatus {
	memberName: string;
	memberId: string;
	remoteDb: string;
	localRoot: string;
	conflicts: number;
}

/**
 * 패널 섹션이 플러그인에 요구하는 동작 모음. CoVaultPlugin이 구현한다.
 * 명령(cmd+P)과 패널 버튼이 같은 메서드를 공유한다.
 *
 * 도메인별 하위 인터페이스로 분리하고 PanelHost로 합성한다(가독성·역할 구분).
 * 구현(CoVaultPlugin)은 구조적 타이핑으로 전체를 만족한다.
 */

/** 공통: 앱/설정/로그/저장소 + 패널·온보딩 제어. */
export interface CoreHost {
	app: App;
	settings: CoVaultSettings;
	logger: Logger;
	feedbackStore: FeedbackStore;
	/** 학급 운영(대시보드) 저장소. */
	classroomStore: ClassroomStore;
	/** 학급 공동 공간이 지정·배포·수신되어 사용 가능한지. */
	homeroomReady(): boolean;
	/** 학급 공동 공간이 '지정'되어 있는지(연결 준비와 무관 — 시작 직후 깜빡임 방지용). */
	homeroomConfigured(): boolean;
	/** 공동 공간으로 설정한 폴더 경로 목록(교사=설정, 구성원=수신한 shares). 대화 위키링크 후보 제한용. */
	sharedFolders(): string[];
	/** 노트 경로의 피드백 목록(대화 피드백 참조 picker용). */
	listFeedback(path: string): Promise<Array<{ uid: string; label: string; path: string }>>;
	/** 피드백 참조 클릭 → 해당 앵커 위치로 이동. */
	openFeedback(path: string, uid: string): Promise<void>;
	/** 설정 저장(대시보드 카드 배치 등 UI에서 직접 갱신용). */
	saveSettings(): Promise<void>;
	/** 플러그인 설정 탭 열기(대시보드 조치 카드 CTA용). */
	openSettings(): void;
	/** 통합 패널의 특정 탭 열기(마법사 → 대시보드 등). */
	activatePanel(tab?: PanelTab): Promise<void>;
	/** 시스템 탭의 초기 서브뷰를 받아 비운다(SystemSection render 시). */
	consumePendingSystemView(): SystemView | null;
	/** 교사 온보딩 완료 표시(마법사 자동 노출 중단). */
	completeOnboarding(): Promise<void>;
}

/** 알림장·수업 안내(게시·응답). */
export interface NoticeHost {
	/** 새 알림장(교사): 초안 본문 파일을 만들어 편집창에서 연다(프론트매터로 작성·게시). */
	newNotice(): Promise<boolean>;
	/** 수업 안내 생성(교사) → uid 반환(시간표 칸 연결용). 초안 파일을 편집창에서 연다. weekKey=주간 태그, slot=칸의 요일/교시 라벨(프론트매터 day/period로 기록). */
	createLesson(title: string, weekKey?: string, slot?: { day: string; period: string }): Promise<string | null>;
	/** 게시(알림장/수업) 삭제(교사): 메타 + 본문 파일 삭제. */
	deleteNotice(notice: NoticeDoc): Promise<void>;
	/** 게시/게시 취소(교사): 메타 + 파일 프론트매터 published 갱신. */
	setNoticePublished(notice: NoticeDoc, published: boolean): Promise<void>;
	/** 비공개 응답(질문) 기록 — 학생 개인 mirror(동료 비공개, 교사만 열람). */
	postPrivateResponse(doc: ResponseDoc): Promise<boolean>;
	/** 특정 구성원 mirror에 비공개 응답 기록(교사가 학생 질문에 답글). */
	postPrivateResponseTo(remoteDb: string, doc: ResponseDoc): Promise<boolean>;
	/** 비공개 응답 수집(질문 + 교사 답글). 교사=전 구성원, 학생=본인. */
	listPrivateResponses(): Promise<ResponseDoc[]>;
	/** 수업 안내(uid) 열기(+학생 읽음 처리). */
	openLesson(uid: string): Promise<void>;
}

/** 대화(메신저) — 학급 채널 + 1:1 DM. */
export interface MessageHost {
	/** 메시지 전송(channel="class"·"dm:<id>"·"group:..."). replyTo=답글 대상 _id. */
	sendMessage(channel: string, body: string, replyTo?: string): Promise<boolean>;
	/** 채널 메시지 목록(오래된→최신). limit 지정 시 최근 limit건만(평가 P-2). */
	listMessages(channel: string, limit?: number): Promise<MessageDoc[]>;
	/** 메시지 삭제(본인 메시지). */
	deleteMessage(channel: string, doc: MessageDoc): Promise<void>;
	/** vault 파일을 채널 첨부 폴더로 복사하고 임베드/링크 마크다운 반환(실패 시 null). */
	attachFileToChannel(channel: string, srcPath: string): Promise<string | null>;
	/** 접근 가능한 그룹 대화방 목록(교사=전부, 구성원=자신 소속분). 채널 드롭다운용. */
	listChatGroups(): Promise<Array<{ channel: string; groupId: string; name: string; memberIds: string[]; memberNames?: Record<string, string>; temp?: boolean }>>;
	/** 명명 그룹 목록(관리 UI). */
	listGroups(): GroupConfig[];
	/** 그룹 생성/수정(교사). */
	saveGroup(group: GroupConfig): Promise<void>;
	/** 그룹 삭제(교사). 그룹 대화방도 삭제. */
	deleteGroup(id: string): Promise<void>;
	/** 라이브 세션 파일의 참여자를 그룹 구성원으로 설정(교사). */
	applyGroupToFile(filePath: string, groupId: string): Promise<void>;
	/** 그룹 대화방을 대화 탭에서 연다. */
	openGroupChat(groupId: string): Promise<void>;
	/** 세션 참여자 명단으로 그룹 대화 열기(교사) — 일치 그룹 재사용, 없으면 임시 그룹 생성. */
	openSessionGroupChat(memberIds: string[]): Promise<void>;
	/** 그룹 신청(구성원). 검증 실패 시 false. */
	requestGroup(input: { name: string; folder: string; memberIds: string[] }): Promise<boolean>;
	/** 내 그룹 신청 목록(구성원, 최신순). */
	listMyGroupRequests(): Promise<GroupRequestDoc[]>;
	/** 내 신청 취소(pending만). */
	cancelGroupRequest(req: GroupRequestDoc): Promise<void>;
	/** 대기 중 그룹 신청 목록(교사). */
	listPendingGroupRequests(): Promise<GroupRequestDoc[]>;
	/** 신청 승인(교사) — 그룹 공간 배포 포함. */
	approveGroupRequest(req: GroupRequestDoc): Promise<boolean>;
	/** 신청 거절(교사). */
	rejectGroupRequest(req: GroupRequestDoc, reason?: string): Promise<void>;
	/** 학급 명단(구성원 신청 모달 선택지 — 교사가 배포한 roster). */
	rosterMembers(): Promise<Array<{ memberId: string; name: string }>>;
	/** 대화 탭을 특정 채널로 연다(그룹 대화 진입). */
	openChat(channel: string): Promise<void>;
	/** 보류 중 초기 대화 채널을 받아 비운다(ChatSection render 시). */
	consumePendingChatChannel(): string | null;
}

/** 실시간 공동 편집 제어·상태. */
export interface RealtimeHost {
	/** 실시간 토큰 재발급/재배포(교사). 설정 변경 후 전파. */
	redeployRealtime(): Promise<void>;
	/** 실시간 공간 토큰을 하나라도 수신했는지(구성원). */
	realtimeTokenReceived(): boolean;
	/** 현재 활성 파일의 실시간 세션 정보(없으면 null). */
	realtimeActiveFile(): { path: string; participants: number } | null;
	/** 현재(이 기기) 활성 실시간 세션 목록. */
	realtimeSessions(): Array<{ path: string; participants: number }>;
	/** 참여자가 지정된 공유 파일(교사=전부, 구성원=자신 지정분). 닫혀 있어도 목록 유지용. */
	listRealtimeFiles(): Promise<Array<{ path: string; memberIds: string[]; memberNames?: Record<string, string> }>>;
	/** 구성원별 실시간 허용/차단(교사). 차단=토큰 미발급 → 파일 동기화만. */
	setMemberRealtime(memberId: string, allowed: boolean): Promise<void>;
	/** 파일의 실시간 참여자 명단(null=전원/미지정). */
	getFileRealtimeParticipants(path: string): Promise<string[] | null>;
	/** 파일별 실시간 참여자 지정(교사). null=전원(지정 해제). */
	setFileRealtimeParticipants(path: string, memberIds: string[] | null): Promise<void>;
	/** 공유 파일 읽기 전용 정책 토글(교사). 켜면 구성원은 실시간 세션 활성 파일만 편집 가능. */
	setSharedReadOnly(on: boolean): Promise<void>;
}

/** 과제(배포·제출·채점). */
export interface AssignmentHost {
	assignmentDefs(): AssignmentDoc[];
	createAssignment(input: {
		title: string;
		instructions: string;
		dueAt?: number;
		points?: number;
		privacy: "mirror" | "shared";
		targetMembers: string[];
		templatePath?: string;
		rubric?: RubricCriterion[];
	}): Promise<boolean>;
	/** 과제 정의 수정(교사) — 정의 갱신 후 재배포(기존 제출/성적 보존). */
	updateAssignment(uid: string, input: {
		title: string;
		instructions: string;
		dueAt?: number;
		points?: number;
		privacy: "mirror" | "shared";
		targetMembers: string[];
		templatePath?: string;
		rubric?: RubricCriterion[];
	}): Promise<boolean>;
	/** 과제 삭제(교사) — 정의 제거 + 학생 상태 문서 soft-delete. */
	deleteAssignment(uid: string): Promise<boolean>;
	/** 과제 보관/해제(교사) — 학생 상태 문서에도 전파. */
	archiveAssignment(uid: string, archived: boolean): Promise<boolean>;
	listMyAssignments(): Promise<AssignmentStateDoc[]>;
	listAssignmentStates(uid: string): Promise<AssignmentStateDoc[]>;
	/** 전체 구성원의 모든 과제 상태(교사 통계용, 구성원당 prefix 조회 1회). */
	listAllAssignmentStates(): Promise<AssignmentStateDoc[]>;
	submitAssignment(state: AssignmentStateDoc): Promise<boolean>;
	unsubmitAssignment(state: AssignmentStateDoc): Promise<boolean>;
	returnAssignment(uid: string, memberId: string, grade: AssignmentGrade): Promise<boolean>;
	openVaultPath(path: string): Promise<void>;
}

/** 루틴(체크리스트). */
export interface RoutineHost {
	listRoutines(): Promise<RoutineDoc[]>;
	createRoutine(input: {
		title: string;
		items: Array<{ label: string; recurrence: "daily" | "weekly"; weekdays?: number[] }>;
	}): Promise<boolean>;
	updateRoutine(
		uid: string,
		input: { title: string; items: Array<{ id?: string; label: string; recurrence: "daily" | "weekly"; weekdays?: number[] }> },
	): Promise<boolean>;
	deleteRoutine(uid: string): Promise<void>;
	/** 루틴 표시 순서 재배치(교사). */
	reorderRoutines(orderedUids: string[]): Promise<void>;
	myRoutineState(uid: string, day: string): Promise<RoutineStateDoc | null>;
	myRoutineDays(uid: string): Promise<RoutineStateDoc[]>;
	toggleRoutineItem(uid: string, day: string, itemId: string, checked: boolean): Promise<boolean>;
	listRoutineStates(uid: string, day: string): Promise<RoutineStateDoc[]>;
	/** 전체 구성원의 모든 루틴 상태(교사 통계용, 구성원당 prefix 조회 1회). */
	listAllRoutineStates(): Promise<RoutineStateDoc[]>;
}

/** 동기화 상태·배포. */
export interface SyncHost {
	getDashboardRows(): Promise<DashboardRow[]>;
	openConflictModal(): void;
	fullSync(dir: "both" | "up" | "down"): Promise<void>;
	toggleAutoSync(): Promise<void>;
	testConnection(): Promise<void>;
	runDiagnostics(): Promise<void>;
	resetLocalCache(): Promise<void>;
	realtimeStatus(): Promise<void>;
	openResetModal(): void;
	refreshShares(): Promise<void>;
	/** 원본 경로(파일/폴더)를 선택 학생들에게 복사. 기술문서 §20. */
	bulkCopy(sourcePath: string, opts: CopyOptions, memberIds: string[]): Promise<CopyResult & { error?: string }>;
	/** 배포 미리보기(dry-run). */
	bulkCopyPreview(sourcePath: string, opts: CopyOptions, memberIds: string[]): Promise<CopyPlan & { error?: string }>;
	deployShared(space: SharedSpace): Promise<void>;
}

/** 삭제 복구·삭제/수정 충돌·버전 히스토리. */
export interface RecoveryHost {
	/** 모든 링크의 삭제된(tombstone) 파일 목록. 복구 패널용(보고서 §2 P1). */
	listDeletedFiles(): Promise<DeletedItem[]>;
	/** 삭제 파일 복구(remoteDb로 담당 링크 라우팅). */
	restoreDeleted(remoteDb: string, dbPath: string, opts?: RestoreOptions): Promise<RestoreResult>;
	/** 삭제 파일 영구 삭제(purge). */
	purgeDeleted(remoteDb: string, dbPath: string): Promise<"purged" | "skipped">;
	// 삭제/수정 충돌 큐 + 최근 영구 삭제 되돌리기 (보고서 §2 P2)
	listDeleteModify(): Promise<DeleteModifyRow[]>;
	resolveDeleteModify(remoteDb: string, dbPath: string, choice: DeleteModifyChoice): Promise<void>;
	listRecentPurges(): Promise<PurgeRow[]>;
	undoPurge(remoteDb: string, id: string): Promise<RestoreResult>;
	clearPurge(remoteDb: string, id: string): Promise<void>;
	// 버전 히스토리 (보고서 §1 P2)
	versionHistoryFor(localPath: string): Promise<VersionDoc[]>;
	restoreVersion(localPath: string, versionDocId: string, opts: { backupCurrent?: boolean }): Promise<"restored" | "missing">;
}

/** 함께 쓰는 플러그인 배포(정책 엔진 P2 — 교사 배포 탭). */
export interface PluginDeployHost {
	/** 플러그인 배포가 가능한 환경(데스크톱)인지. */
	pluginDeploySupported(): boolean;
	/** 이 기기에 설치된 커뮤니티 플러그인 목록(CoVault 제외). */
	listInstalledPlugins(): InstalledPlugin[];
	/** 현재 학급에 배포된 플러그인 목록. */
	listDeployedPlugins(): Promise<PluginDeployDoc[]>;
	/** 플러그인 배포. */
	deployPlugin(pluginId: string, opts: { shareSettings: boolean; managedSettings: boolean }): Promise<boolean>;
	/** 배포 회수(문서 soft-delete). */
	undeployPlugin(pluginId: string): Promise<void>;
}

export interface PanelHost extends CoreHost, NoticeHost, MessageHost, RealtimeHost, AssignmentHost, RoutineHost, SyncHost, RecoveryHost, PluginDeployHost {}

/** 링크 라벨이 붙은 삭제/수정 충돌 항목. */
export interface DeleteModifyRow extends DeleteModifyItem {
	remoteDb: string;
	memberName: string;
}

/** 링크 라벨이 붙은 최근 영구 삭제 스냅샷. */
export interface PurgeRow extends PurgeSnapshot {
	remoteDb: string;
	memberName: string;
}

/** 탭 콘텐츠 렌더러. 탭 전환 시 render→dispose 로 교체된다(구독·interval은 dispose에서 해제). */
export interface PanelSection {
	render(container: HTMLElement): void | Promise<void>;
	dispose(): void;
	/** 이미 활성인 탭을 다시 눌렀을 때(예: 대시보드 첫 페이지로 복귀). */
	onReactivate?(): void;
}

/** 패널 액션 버튼 헬퍼. */
export function panelButton(
	parent: HTMLElement,
	label: string,
	onClick: () => void | Promise<void>,
	opts?: { warning?: boolean; cta?: boolean },
): HTMLButtonElement {
	const b = parent.createEl("button", { text: label });
	if (opts?.warning) b.addClass("mod-warning");
	if (opts?.cta) b.addClass("mod-cta");
	b.onclick = () => void onClick();
	return b;
}

/** 아이콘 버튼(모듈 헤더 뒤로 등). lucide 아이콘 + 접근성 라벨. */
export function iconButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	onClick: () => void | Promise<void>,
): HTMLButtonElement {
	// clickable-icon: 옵시디언 기본 아이콘 버튼 클래스. 데스크톱/모바일 모두에서
	// 아이콘 크기(--icon-size)·색(--icon-color)을 일관되게 적용한다.
	const b = parent.createEl("button", { cls: "clickable-icon covault-cr-iconbtn" });
	setIcon(b, icon);
	b.setAttr("aria-label", label);
	b.title = label;
	b.onclick = () => void onClick();
	return b;
}
