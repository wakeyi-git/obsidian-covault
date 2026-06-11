import { CoVaultSettings } from "./types";
import { t } from "../i18n";

/** 내보낼 때 제외할 자격증명/기기 고유 키. 기술문서 §22.4. */
const SECRET_KEYS: Array<keyof CoVaultSettings> = ["password", "yjsSecret"];
// 비밀값은 Secret Storage에 있고 이전 여부(*Set) 마커는 기기별 상태이므로 내보내지 않는다.
const DEVICE_KEYS: Array<keyof CoVaultSettings> = ["deviceId", "lastSeqByDb", "yjsSecretSet", "passwordSet", "validatePolicyByDb", "lastTombstoneSweepAt"];

/** 가져올 때 구조/옵션으로 병합할 키(현재 기기의 secret·device·role은 보존). */
const IMPORT_KEYS: Array<keyof CoVaultSettings> = [
	"workspaceId",
	"displayName",
	"couchdbUrl",
	"username",
	"remoteDb",
	"localRoot",
	"members",
	"sharedSpaces",
	"personalSyncEnabled",
	"personalRemoteDb",
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
	"inviteTtlDays",
	"deleteReconcileMax",
	"versionHistory",
	"versionMaxCount",
	"versionMaxAgeDays",
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
	const copy: any = JSON.parse(JSON.stringify(s));
	for (const k of [...SECRET_KEYS, ...DEVICE_KEYS]) delete copy[k];
	if (Array.isArray(copy.members)) {
		for (const st of copy.members) {
			delete st.password; // 학생 비밀번호는 내보내지 않음
			delete st.realtimeToken; // mirror 실시간 토큰(베어러)도 내보내지 않음
			delete st.managerMirrorToken;
		}
	}
	if (Array.isArray(copy.sharedSpaces)) {
		for (const sp of copy.sharedSpaces) delete sp.token; // 공간 실시간 토큰(베어러)도 내보내지 않음
	}
	const payload: PortablePayload = {
		_meta: { app: "covault", version: 1, exportedAt: new Date().toISOString() },
		settings: copy,
	};
	return JSON.stringify(payload, null, 2);
}

/**
 * 가져온 JSON을 현재 설정에 병합한 새 설정을 반환. 구조/옵션만 반영하고
 * 현재 기기의 secret(password·yjsSecret·members[].password)·device(deviceId·lastSeqByDb)·role·setupComplete는 보존.
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
	for (const k of IMPORT_KEYS) {
		if (incoming[k] !== undefined) (merged as any)[k] = incoming[k];
	}
	// 가져온 학생의 password는 비움(이 기기에서 재초대 필요). 다른 secret/device/role은 current 그대로 유지.
	if (Array.isArray(merged.members)) {
		merged.members = merged.members.map((st) => ({ ...st, password: undefined }));
	}
	return { ok: true, settings: merged };
}
