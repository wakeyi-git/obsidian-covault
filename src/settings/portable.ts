import { CoVaultSettings } from "./types";
import { t } from "../i18n";

/**
 * 백업 가능한 사용자 구성의 단일 목록. 내보내기와 가져오기가 같은 목록을 사용해 새 옵션이 한쪽에서만
 * 빠지는 비대칭을 막는다. 역할/사용자 id, 자격증명·Secret Storage 마커, 체크포인트·최근 UI 상태는 제외한다.
 */
export const PORTABLE_KEYS: Array<keyof CoVaultSettings> = [
	"managerOnboardingDone",
	"workspaceId",
	"displayName",
	"couchdbUrl",
	"username",
	"remoteDb",
	"localRoot",
	"members",
	"sharedSpaces",
	"groups",
	"groupAutoApprove",
	"groupMaxPerMember",
	"managerSyncTransport",
	"personalSyncEnabled",
	"personalRemoteDb",
	"assignments",
	"noticeTemplate",
	"lessonTemplate",
	"assignmentTemplate",
	"excludeFolders",
	"archiveFolder",
	"conflictFolder",
	"autoSync",
	"syncAssets",
	"maxAttachmentMB",
	"debounceMs",
	"mobileDebounceMs",
	"pauseWhenHidden",
	"conflictPolicy",
	"deletePolicy",
	"realtimeEnabled",
	"yjsServerUrl",
	"realtimeSnapshotSec",
	"sharedReadOnly",
	"yjsTokenTtlDays",
	"rtServiceUsername",
	"inviteTtlDays",
	"deleteReconcileMax",
	"versionHistory",
	"versionMaxCount",
	"versionMaxAgeDays",
	"panelTabs",
	"rememberLastTab",
	"dashboardPageSize",
	"dashboardOrder",
	"classroomModules",
	"language",
];

export interface PortablePayload {
	_meta: { app: "covault"; version: number; exportedAt: string };
	settings: Partial<CoVaultSettings>;
}

/**
 * 설정을 자격증명·기기 고유값을 제외하고 직렬화(JSON 문자열). 기술문서 §22.4.
 * password·yjsSecret·deviceId·lastSeqByDb 제거, members[].password 제거.
 */
export function exportSettings(s: CoVaultSettings): string {
	const copy: Partial<CoVaultSettings> = {};
	for (const key of PORTABLE_KEYS) {
		if (s[key] !== undefined) (copy as any)[key] = JSON.parse(JSON.stringify(s[key]));
	}
	if (Array.isArray(copy.members)) {
		for (const st of copy.members) {
			delete st.password; // 학생 비밀번호는 내보내지 않음
			delete st.realtimeToken; // mirror 실시간 토큰(베어러)도 내보내지 않음
			delete st.managerMirrorToken;
			delete st.realtimeTokenSet; // Secret Storage 이전 마커는 기기별 상태(평가 S-1)
			delete st.managerMirrorTokenSet;
		}
	}
	if (Array.isArray(copy.sharedSpaces)) {
		for (const sp of copy.sharedSpaces) {
			delete sp.token; // 공간 실시간 토큰(베어러)도 내보내지 않음
			delete sp.tokenSet; // Secret Storage 이전 마커는 기기별 상태(평가 S-1)
		}
	}
	const payload: PortablePayload = {
		_meta: { app: "covault", version: 2, exportedAt: new Date().toISOString() },
		settings: copy,
	};
	return JSON.stringify(payload, null, 2);
}

/**
 * 가져온 JSON을 현재 설정에 병합한 새 설정을 반환. 사용자 구성만 반영하고 현재 기기의
 * device/checkpoint/role/setupComplete/userId는 보존한다. 자격증명과 서버 배포 상태는 비워 재입력·재배포한다.
 */
export function importSettings(
	current: CoVaultSettings,
	json: string,
): { ok: true; settings: CoVaultSettings } | { ok: false; error: string } {
	let payload: PortablePayload;
	try {
		payload = JSON.parse(json);
	} catch {
		return { ok: false, error: t("backup.not_valid_json") };
	}
	if (!payload || payload._meta?.app !== "covault" || typeof payload.settings !== "object") {
		return { ok: false, error: t("backup.not_a_covault_settings_backup") };
	}

	const merged: CoVaultSettings = { ...current };
	const incoming = payload.settings as any;
	for (const key of ["members", "sharedSpaces", "groups", "assignments", "excludeFolders", "panelTabs", "dashboardOrder"] as const) {
		if (incoming[key] !== undefined && !Array.isArray(incoming[key])) {
			return { ok: false, error: t("backup.not_a_covault_settings_backup") };
		}
	}
	for (const k of PORTABLE_KEYS) {
		if (incoming[k] !== undefined) (merged as any)[k] = incoming[k];
	}
	// 백업은 비밀값을 포함하지 않는다. 기존 기기 Secret Storage도 호출측(main)이 비우므로 marker/fallback을 함께 초기화.
	merged.password = "";
	merged.passwordSet = false;
	merged.yjsSecret = undefined;
	merged.yjsSecretSet = false;
	merged.rtServicePasswordSet = false;
	// 가져온 학생/공간은 이 기기에서 재초대·재배포해야 한다. 서버 상태·토큰 marker를 신뢰하지 않는다.
	if (Array.isArray(merged.members)) {
		merged.members = merged.members.map((st) => ({
			...st,
			password: undefined,
			provisioned: false,
			realtimeToken: undefined,
			realtimeTokenSet: false,
			managerMirrorToken: undefined,
			managerMirrorTokenSet: false,
		}));
	}
	if (Array.isArray(merged.sharedSpaces)) {
		merged.sharedSpaces = merged.sharedSpaces.map((sp) => ({
			...sp,
			provisioned: false,
			token: undefined,
			tokenSet: false,
			lastDeployedAt: undefined,
			lastMemberSnapshot: undefined,
		}));
	}
	return { ok: true, settings: merged };
}
