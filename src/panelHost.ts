import { App, Notice } from "obsidian";
import { Logger } from "./core/log/Logger";
import { CoVaultSettings } from "./settings/types";
import { FeedbackStore } from "./core/feedback/FeedbackStore";
import { ClassroomStore } from "./core/classroom/ClassroomStore";
import { ClassroomController } from "./modes/ClassroomController";
import { ParticipantController } from "./modes/ParticipantController";
import { RecoveryController } from "./modes/RecoveryController";
import { GroupRequestController } from "./modes/GroupRequestController";
import { DeploymentController } from "./modes/DeploymentController";
import { RealtimeController } from "./modes/RealtimeController";
import { ServerResetController } from "./modes/ServerResetController";
import { MemberController } from "./modes/MemberController";
import { CoVaultPanelView, PANEL_VIEW_TYPE } from "./ui/PanelView";
import { PanelHost, PanelTab, SystemView } from "./ui/panel/PanelSection";
import { ConflictModal } from "./ui/ConflictModal";
import { confirm } from "./ui/ConfirmModal";
import { jumpToFeedback } from "./ui/feedbackJump";
import { t } from "./i18n";

/**
 * PanelHost 조립(평가 M-12). main.ts가 84개 위임 메서드로 PanelHost를 구현하던 것을,
 * 컨트롤러들의 동일 시그니처 메서드를 그대로 묶어 객체로 조립한다 — main은 수명주기·DI 배선만 남는다.
 * 이 모듈은 main·commands와 같은 "애플리케이션 배선" 계층(src 루트)이다(ui→modes 값 import 회피).
 */

/**
 * 메서드명 배열로 bound 함수를 추출. `K extends keyof T`라 이름 오타는 컴파일 에러,
 * 반환을 PanelHost에 스프레드하므로 시그니처 불일치도 컴파일 에러로 잡힌다.
 * ⚠ getter는 여기로 옮기지 않는다 — 스프레드/대입은 getter를 즉시 평가해 값으로 복사한다.
 */
function pick<T extends object, K extends keyof T>(src: T, keys: readonly K[]): Pick<T, K> {
	const out = {} as Pick<T, K>;
	for (const k of keys) {
		const v = src[k];
		out[k] = (typeof v === "function" ? (v as unknown as (...a: never[]) => unknown).bind(src) : v) as Pick<T, K>[K];
	}
	return out;
}

/**
 * 패널 활성화 + 보류 채널/서브뷰 상태. main의 pendingChatChannel/pendingSystemView 필드와
 * activatePanel/openChat/openSystemView/openLog/consume* 묶음을 이전(거동 동일).
 */
export class PanelNavigator {
	private pendingChatChannel: string | null = null; // 그룹 대화 카드 → 대화 탭 초기 채널 전달
	private pendingSystemView: SystemView | null = null; // 명령/CTA → 시스템 탭 초기 서브뷰 전달

	constructor(private app: App) {}

	/** 통합 패널 활성화(우측 사이드바). tab을 주면 해당 탭으로 전환. */
	async activatePanel(tab?: PanelTab): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)[0];
		if (!leaf) {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: PANEL_VIEW_TYPE, active: true });
			leaf = right;
		}
		await this.app.workspace.revealLeaf(leaf);
		// Deferred views: revealLeaf가 로드를 트리거하지만 view가 즉시 CoVaultPanelView로
		// 바뀌지 않을 수 있다(차가운 리프). 탭 전환이 필요할 때만 명시적으로 로드를 보장한다.
		if (tab) {
			await leaf.loadIfDeferred?.();
			if (leaf.view instanceof CoVaultPanelView) leaf.view.setTab(tab);
		}
	}

	/** 대화 탭을 특정 채널로 연다. ChatSection이 render 시 consumePendingChatChannel로 받는다. */
	async openChat(channel: string): Promise<void> {
		this.pendingChatChannel = channel;
		await this.activatePanel("chat");
	}

	consumePendingChatChannel(): string | null {
		const c = this.pendingChatChannel ?? null;
		this.pendingChatChannel = null;
		return c;
	}

	/** 시스템 탭을 특정 서브뷰(동기화/복구/이력/로그)로 연다. */
	async openSystemView(view: SystemView): Promise<void> {
		this.pendingSystemView = view;
		await this.activatePanel("system");
	}

	consumePendingSystemView(): SystemView | null {
		const v = this.pendingSystemView ?? null;
		this.pendingSystemView = null;
		return v;
	}

	/** 로그 패널 열기(시스템 탭 → 로그 서브뷰). 진단·동기화 출력 표시용. */
	openLog(): Promise<void> {
		return this.openSystemView("log");
	}
}

/** 조립 재료. settings는 load/import에서 객체가 교체되므로 반드시 getter로 받는다. */
export interface PanelHostDeps {
	app: App;
	logger: Logger;
	nav: PanelNavigator;
	feedback: FeedbackStore;
	classroom: ClassroomStore;
	settings(): CoVaultSettings;
	// 도메인 컨트롤러 — Host와 시그니처 1:1
	classroomCtl: ClassroomController;
	participantCtl: ParticipantController;
	recoveryCtl: RecoveryController;
	groupRequestCtl: GroupRequestController;
	deploymentCtl: DeploymentController;
	realtimeCtl: RealtimeController;
	serverResetCtl: ServerResetController;
	memberCtl: MemberController;
	// main 잔존 글루(모드/Plugin 수명주기에 결박된 동작)
	homeroomReady(): boolean;
	homeroomConfigured(): boolean;
	saveSettings(): Promise<void>;
	openSettings(): void;
	completeOnboarding(): Promise<void>;
	fullSync(dir: "both" | "up" | "down"): Promise<void>;
	toggleAutoSync(): Promise<void>;
	refreshShares(): Promise<void>;
	runDiagnostics(): Promise<void>;
	openResetModal(): void;
}

export function buildPanelHost(d: PanelHostDeps): PanelHost {
	return {
		// --- CoreHost. getter는 리터럴에 직접 선언(라이브 평가 — settings 교체·mode 시작 시점 대응). ---
		get app() {
			return d.app;
		},
		get settings() {
			return d.settings();
		},
		get logger() {
			return d.logger;
		},
		get feedbackStore() {
			return d.feedback;
		},
		get classroomStore() {
			return d.classroom;
		},
		homeroomReady: d.homeroomReady,
		homeroomConfigured: d.homeroomConfigured,
		saveSettings: d.saveSettings,
		openSettings: d.openSettings,
		completeOnboarding: d.completeOnboarding,
		activatePanel: (tab) => d.nav.activatePanel(tab),
		consumePendingSystemView: () => d.nav.consumePendingSystemView(),
		openChat: (ch) => d.nav.openChat(ch),
		consumePendingChatChannel: () => d.nav.consumePendingChatChannel(),

		/** 노트의 피드백 목록(대화 피드백 참조 picker용). */
		async listFeedback(path: string): Promise<Array<{ uid: string; label: string; path: string }>> {
			const docs = await d.feedback.listFor(path);
			return docs.map((doc) => ({
				uid: doc._id.split(":").pop() ?? doc._id,
				label: (doc.content || "").replace(/\s+/g, " ").trim().slice(0, 40) || path.split("/").pop() || path,
				path,
			}));
		},
		/** 피드백 참조 클릭 → 앵커 위치로 이동. */
		async openFeedback(path: string, uid: string): Promise<void> {
			const docs = await d.feedback.listFor(path);
			const doc = docs.find((x) => (x._id.split(":").pop() ?? "") === uid);
			if (!doc) {
				new Notice(t("chat.feedback_not_found"));
				return;
			}
			await jumpToFeedback(d.app, doc, path);
		},

		// --- 알림장·과제·루틴·대화(콘텐츠) — ClassroomController 1:1 ---
		...pick(d.classroomCtl, [
			"newNotice",
			"createLesson",
			"deleteNotice",
			"setNoticePublished",
			"openLesson",
			"postPrivateResponse",
			"postPrivateResponseTo",
			"listPrivateResponses",
			"assignmentDefs",
			"createAssignment",
			"updateAssignment",
			"deleteAssignment",
			"listMyAssignments",
			"listAssignmentStates",
			"listAllAssignmentStates",
			"submitAssignment",
			"unsubmitAssignment",
			"returnAssignment",
			"openVaultPath",
			"listRoutines",
			"createRoutine",
			"updateRoutine",
			"deleteRoutine",
			"reorderRoutines",
			"myRoutineState",
			"myRoutineDays",
			"toggleRoutineItem",
			"listRoutineStates",
			"listAllRoutineStates",
			"sendMessage",
			"listMessages",
			"deleteMessage",
			"attachFileToChannel",
			"listChatGroups",
		] as const),

		// --- 그룹 라이프사이클·신청-승인 — GroupRequestController ---
		...pick(d.groupRequestCtl, [
			"listGroups",
			"saveGroup",
			"deleteGroup",
			"openGroupChat",
			"openSessionGroupChat",
			"requestGroup",
			"rosterMembers",
		] as const),
		// Host명 ≠ 컨트롤러명 — 명시 arrow
		listMyGroupRequests: () => d.groupRequestCtl.listMyRequests(),
		cancelGroupRequest: (req) => d.groupRequestCtl.cancelRequest(req),
		listPendingGroupRequests: () => d.groupRequestCtl.listPendingRequests(),
		approveGroupRequest: (req) => d.groupRequestCtl.approveRequest(req),
		rejectGroupRequest: (req, reason) => d.groupRequestCtl.rejectRequest(req, reason),
		/** 라이브 세션에 그룹 적용: 그 파일의 참여자를 그룹 구성원으로 설정(교사). */
		applyGroupToFile: async (filePath, groupId) => {
			const g = d.settings().groups.find((x) => x.id === groupId);
			if (!g) return;
			await d.participantCtl.setFileRealtimeParticipants(filePath, g.memberIds);
		},

		// --- 실시간 게이트·참여자 — ParticipantController / MemberController ---
		...pick(d.participantCtl, [
			"realtimeTokenReceived",
			"realtimeSessions",
			"realtimeActiveFile",
			"listRealtimeFiles",
			"getFileRealtimeParticipants",
			"setFileRealtimeParticipants",
			"setSharedReadOnly",
		] as const),
		setMemberRealtime: (memberId, allowed) => d.memberCtl.setMemberRealtime(memberId, allowed),
		realtimeStatus: () => d.realtimeCtl.realtimeStatus(),

		// --- 동기화 상태·배포·복구 — Deployment/RecoveryController + main 글루 ---
		...pick(d.deploymentCtl, ["redeployRealtime", "deployShared", "testConnection", "bulkCopy", "bulkCopyPreview"] as const),
		...pick(d.recoveryCtl, [
			"getDashboardRows",
			"listDeletedFiles",
			"restoreDeleted",
			"purgeDeleted",
			"listDeleteModify",
			"resolveDeleteModify",
			"listRecentPurges",
			"undoPurge",
			"clearPurge",
			"versionHistoryFor",
			"restoreVersion",
		] as const),
		openConflictModal: () => new ConflictModal(d.app, d.recoveryCtl).open(),
		/** 로컬 캐시 초기화(확인 후 — 미업로드 변경 유실 가능). */
		resetLocalCache: async () => {
			const ok = await confirm(d.app, {
				title: t("command.reset_cache_confirm_title"),
				message: t("command.reset_cache_confirm_body"),
				confirmText: t("common.reset"),
				warning: true,
			});
			if (ok) await d.serverResetCtl.resetLocalCache();
		},
		fullSync: d.fullSync,
		toggleAutoSync: d.toggleAutoSync,
		refreshShares: d.refreshShares,
		runDiagnostics: d.runDiagnostics,
		openResetModal: d.openResetModal,
	};
}
