/**
 * Excalidraw 첫 진입 시드의 결정적 시더 선출(평가 M-10). 순수 모듈 — 테스트 대상.
 *
 * 기존엔 "yElements가 비어 있으면 내 씬을 시드"였는데, 두 클라이언트가 거의 동시에 같은 그림을
 * 열면 둘 다 시드해 요소가 중복될 수 있다. awareness의 clientID는 전 피어에게 동일하게 보이므로
 * **최소 clientID인 클라이언트만** 시드하면 전원이 같은 결론에 도달한다(코디네이터 불요).
 */

/** awareness가 피어를 교환할 시간(시드 판정 유예). 그 사이 원격 요소가 오면 시드 자체가 불필요해진다. */
export const SEED_SETTLE_MS = 250;
/** 비시더의 폴백 대기 — 시더가 이탈/실패해 여전히 비어 있으면 직접 시드한다. */
export const SEED_FALLBACK_MS = 2000;

/** 내가 시더인가 — 보이는 피어(나 포함) 중 clientID 최솟값이면 true. */
export function isSeeder(myClientId: number, peerClientIds: Iterable<number>): boolean {
	let min = myClientId;
	for (const id of peerClientIds) {
		if (id < min) min = id;
	}
	return min === myClientId;
}
