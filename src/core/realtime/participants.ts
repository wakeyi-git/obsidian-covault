/**
 * 파일별 실시간 참여 게이트의 순수 결정 로직.
 * main.ts의 canEditRealtime / listRealtimeFiles / setFileRealtimeParticipants / backfillRtPartNames에
 * 인라인으로 흩어져 있던 판단을 한곳에 모아 단위 테스트 가능하게 한다(거동 동일).
 */

/** 참여자 지정 문서(요지). RtPartDoc의 판단에 필요한 필드만. */
export interface RtPartLike {
	memberIds: string[];
	deleted?: boolean;
}

/** 지정 문서가 없을 때 기본 허용: 읽기 전용이면 아무도(false), 아니면 전원(true). */
export function defaultParticipation(sharedReadOnly: boolean): boolean {
	return !sharedReadOnly;
}

/**
 * 공유 파일에서 이 구성원이 라이브 편집 가능한가.
 * 지정 문서가 곧 허용 명단(있으면 명단 포함 여부), 없거나 삭제됐으면 기본값.
 */
export function memberAllowed(doc: RtPartLike | null | undefined, userId: string, sharedReadOnly: boolean): boolean {
	if (doc && !doc.deleted) return doc.memberIds.includes(userId);
	return defaultParticipation(sharedReadOnly);
}

/** 목록에서 이 사용자에게 보일 파일인가: 교사=전부, 구성원=자신이 지정된 것만. */
export function visibleToUser(memberIds: string[], userId: string, role: "manager" | "member"): boolean {
	return role === "manager" || memberIds.includes(userId);
}

/** memberId→표시 이름 맵 계산(명단에 이름이 있는 것만 담는다 — 학생 카드에 이름 표시용). */
export function memberNameMap(
	memberIds: string[],
	roster: Array<{ memberId: string; memberName?: string }>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const id of memberIds) {
		const m = roster.find((x) => x.memberId === id);
		if (m?.memberName) out[id] = m.memberName;
	}
	return out;
}

/** 구버전 문서 이름 백필 필요 판정: 계산 이름이 기존과 다르고 채울 이름이 하나라도 있으면 true. */
export function nameBackfillNeeded(
	memberIds: string[],
	current: Record<string, string> | undefined,
	computed: Record<string, string>,
): boolean {
	const cur = current ?? {};
	const changed = memberIds.some((id) => (computed[id] || "") !== (cur[id] || ""));
	return changed && Object.keys(computed).length > 0;
}
