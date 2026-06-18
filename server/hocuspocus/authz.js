/**
 * 실시간 인가 규칙 + 권한 변경 시 재인가 대상 선별 (순수 로직 — server.js에서 분리해 vitest로 고정).
 *
 * 배경: rtpart/rtcontrol 변경을 _changes로 감지하면 예전엔 영향 문서의 **모든** 연결을 닫아 전원 재인가시켰다
 * (Hocuspocus closeConnections(documentName)). 참여자를 한 명씩 추가하는 흔한 운영(예: 7명 지정)에서도 매
 * 추가마다 전원이 끊겼다 재접속하며 종료 스냅샷을 디스크에 써 비-RT(파일 동기화) 경로로 업로드 → 서버
 * 스냅샷과 경쟁했다(노트 중복 누적의 토대 — 현장 버그).
 *
 * 올바른 방식: 권한 변경 시 **연결별로 현재 권한을 재평가**해 더는 허용되지 않는 연결만 닫는다(Hocuspocus는
 * connection.context에 onAuthenticate 결과를 보관하고 connection.close()로 단건 종료를 지원한다). 그러면
 * 멤버 추가는 누구도 끊기지 않고(churn 0), 제거는 그 멤버만 끊긴다. 입장 규칙(memberAllowed)을 재평가에
 * 그대로 재사용하므로 onAuthenticate와 판정이 항상 일치한다.
 */

/**
 * 공유 파일에서 이 멤버가 입장 가능한가 — 플러그인 src/core/realtime/participants.ts memberAllowed()와 동형.
 *   - manager(교사) / mirror 공간(1:1)은 항상 허용
 *   - rtpart 있음(&!deleted) → memberIds 포함 여부
 *   - 없음 → !rtcontrol.sharedReadOnly(읽기전용이면 거부, 아니면 전원 허용)
 */
export function memberAllowed(claims, room, rtpart, rtcontrol) {
	if (claims.r === "manager") return true;
	if (room.spaceId.startsWith("mirror-")) return true;
	if (rtpart && !rtpart.deleted) {
		return Array.isArray(rtpart.memberIds) && rtpart.memberIds.includes(claims.m);
	}
	return !rtcontrol?.sharedReadOnly;
}

/**
 * 새 권한(rtpart/rtcontrol) 기준으로 현재 연결들 중 **더는 허용되지 않는** 것들을 가린다(닫을 대상).
 * conns: [{ ref, claims, room }] — ref는 호출측이 닫기에 쓰는 연결 핸들(여기선 불투명). claims/room이
 * 없는 연결(인증 전 등)은 건드리지 않는다(판단 불가 → 유지). 허용되는 연결은 모두 그대로 유지된다.
 * 멤버 추가만 일어나면 결과가 비어 churn이 없고, 제거된 멤버의 연결만 결과에 담긴다.
 */
export function connectionsToClose(conns, rtpart, rtcontrol) {
	return conns.filter((c) => c && c.claims && c.room && !memberAllowed(c.claims, c.room, rtpart, rtcontrol));
}
