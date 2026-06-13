// 실시간 서버 거부 재시도 백오프(평가 P2-1) — 지수 증가·60s 상한·상태 전이·게이트를 순수 함수로 고정.
import { describe, it, expect } from "vitest";
import { backoffDelay, nextRetryState, inBackoff } from "./retryBackoff";

describe("backoffDelay — 지수 증가, 60s 상한", () => {
	it("2s·2^(n-1)", () => {
		expect(backoffDelay(1)).toBe(2_000);
		expect(backoffDelay(2)).toBe(4_000);
		expect(backoffDelay(3)).toBe(8_000);
		expect(backoffDelay(4)).toBe(16_000);
		expect(backoffDelay(5)).toBe(32_000);
	});
	it("6회 이상은 60s로 상한", () => {
		expect(backoffDelay(6)).toBe(60_000);
		expect(backoffDelay(10)).toBe(60_000);
	});
});

describe("nextRetryState — 실패 누적 + until 계산(now 주입)", () => {
	it("최초 실패 → failures=1, until=now+2s", () => {
		expect(nextRetryState(undefined, 1_000)).toEqual({ failures: 1, until: 3_000 });
	});
	it("연속 실패는 failures를 누적하고 지연도 커진다", () => {
		const s1 = nextRetryState(undefined, 0);
		const s2 = nextRetryState(s1, 100_000);
		expect(s2.failures).toBe(2);
		expect(s2.until).toBe(100_000 + 4_000);
	});
	it("상한 도달 후에도 failures는 계속 누적되나 지연은 60s 고정", () => {
		let st = nextRetryState(undefined, 0);
		for (let i = 0; i < 9; i++) st = nextRetryState(st, 0);
		expect(st.failures).toBe(10);
		expect(st.until).toBe(60_000); // now=0 + 상한 60s
	});
});

describe("inBackoff — 재접속 게이트", () => {
	it("상태 없으면 백오프 아님", () => {
		expect(inBackoff(undefined, 5_000)).toBe(false);
	});
	it("now가 until 전이면 백오프 중, 지나면 해제", () => {
		const st = { failures: 1, until: 3_000 };
		expect(inBackoff(st, 2_999)).toBe(true);
		expect(inBackoff(st, 3_000)).toBe(false); // until 시각엔 해제(원래 < 비교)
		expect(inBackoff(st, 3_001)).toBe(false);
	});
});
