import { DashboardRow } from "./PanelSection";
import { CoVaultSettings } from "../../settings/types";

export type SyncOverall = "ok" | "attention" | "offline" | "autosync-off" | "empty";

export interface SyncSummary {
	overall: SyncOverall;
	members: number; // 교사: 학생 수 (학생: 링크 수)
	invited: number; // 프로비저닝 완료 수
	notInvited: number; // 초대(프로비저닝) 안 된 학생 수
	shared: number; // 공유 공간 수
	conflicts: number; // 충돌 총합
	problems: number; // offline+error 링크 수
	realtimeTokenMissing: boolean;
	autoSyncOff: boolean;
	lastSyncAt: number; // 마지막 업/다운로드 시각(없으면 0)
}

/** 대시보드 상단 요약 + 조치 카드용 모델 계산(순수 함수, 테스트 가능). */
export function computeSyncSummary(rows: DashboardRow[], s: CoVaultSettings): SyncSummary {
	const manager = s.role === "manager";
	const members = manager ? s.members.length : rows.length;
	const invited = manager ? s.members.filter((st) => st.provisioned).length : rows.length;
	const notInvited = manager ? s.members.filter((st) => st.memberId && !st.provisioned).length : 0;
	const shared = s.sharedSpaces.length;
	const conflicts = rows.reduce((n, r) => n + (r.conflicts || 0), 0);
	const errorCount = rows.filter((r) => r.state === "error").length;
	const offlineCount = rows.filter((r) => r.state === "offline").length;
	const problems = errorCount + offlineCount;

	const realtimeTokenMissing =
		!!s.realtimeEnabled &&
		!!s.yjsServerUrl &&
		shared > 0 &&
		// 토큰은 Secret Storage(tokenSet 플래그) 또는 평문 폴백(token) 어느 쪽이든 있으면 발급된 것(평가 S-1).
		s.sharedSpaces.some((sp) => !sp.token && !sp.tokenSet);

	const autoSyncOff = !s.autoSync;

	let lastSyncAt = 0;
	for (const r of rows) lastSyncAt = Math.max(lastSyncAt, r.lastUploadAt ?? 0, r.lastDownloadAt ?? 0);

	let overall: SyncOverall;
	if (members === 0) overall = "empty";
	else if (errorCount > 0 || conflicts > 0) overall = "attention";
	else if (offlineCount > 0) overall = "offline";
	else if (autoSyncOff) overall = "autosync-off";
	else overall = "ok";

	return {
		overall,
		members,
		invited,
		notInvited,
		shared,
		conflicts,
		problems,
		realtimeTokenMissing,
		autoSyncOff,
		lastSyncAt,
	};
}
