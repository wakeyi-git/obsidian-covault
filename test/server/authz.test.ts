// 실시간 인가 규칙(memberAllowed)과 권한 변경 시 재인가 대상 선별(connectionsToClose)을 고정한다.
// 핵심 회귀 방지: 참여자를 한 명씩 추가하는 흔한 운영에서 _changes가 전체 연결을 끊어(churn) 클라이언트가
// 종료 스냅샷을 비-RT 경로로 업로드 → 서버 스냅샷과 경쟁(노트 중복 누적의 토대)했던 현장 버그.
// 올바른 동작: 멤버 추가는 누구도 닫히지 않고(churn 0), 권한을 잃은 멤버(제거·읽기전용)만 닫힌다.
import { describe, it, expect } from "vitest";
import { memberAllowed, connectionsToClose } from "../../server/hocuspocus/authz.js";

const room = (spaceId: string) => ({ spaceId, dbPath: "모둠활동/전체.md" });
const member = (m: string) => ({ m, r: "member" as const });
const manager = { m: "t1", r: "manager" as const };
// 연결 핸들(ref)은 불투명 — 테스트에선 식별용 문자열만 둔다.
const conn = (m: string, spaceId = "g1") => ({ ref: m, claims: member(m), room: room(spaceId) });

describe("memberAllowed — 입장 인가 규칙(플러그인 participants.ts와 동형)", () => {
	it("manager(교사)는 항상 허용", () => {
		expect(memberAllowed(manager, room("g1"), null, { sharedReadOnly: true })).toBe(true);
	});

	it("mirror 공간(1:1)은 항상 허용", () => {
		expect(memberAllowed(member("m1"), room("mirror-student_3"), null, { sharedReadOnly: true })).toBe(true);
	});

	it("rtpart 있으면 명단 포함 여부로 판정(rtcontrol 무관)", () => {
		const rtpart = { memberIds: ["m1", "m2"] };
		expect(memberAllowed(member("m1"), room("g1"), rtpart, { sharedReadOnly: true })).toBe(true);
		expect(memberAllowed(member("m9"), room("g1"), rtpart, { sharedReadOnly: false })).toBe(false);
	});

	it("rtpart 삭제(deleted)면 없는 것으로 보고 rtcontrol 기본값 적용", () => {
		const rtpart = { memberIds: ["m1"], deleted: true };
		expect(memberAllowed(member("m1"), room("g1"), rtpart, { sharedReadOnly: true })).toBe(false);
		expect(memberAllowed(member("m1"), room("g1"), rtpart, { sharedReadOnly: false })).toBe(true);
	});

	it("rtpart 없으면 rtcontrol.sharedReadOnly로: 읽기전용=거부, 아니면 전원 허용", () => {
		expect(memberAllowed(member("m1"), room("g1"), null, { sharedReadOnly: true })).toBe(false);
		expect(memberAllowed(member("m1"), room("g1"), null, { sharedReadOnly: false })).toBe(true);
		expect(memberAllowed(member("m1"), room("g1"), null, null)).toBe(true); // rtcontrol 문서 자체가 없음 → 전원 허용
	});
});

describe("connectionsToClose — 권한 변경 후 닫아야 할 연결(나머지는 유지)", () => {
	const conns = [conn("m1"), conn("m2"), conn("m3")];

	it("멤버 추가(전원이 여전히 명단에 있음)는 아무도 닫지 않음 → churn 0", () => {
		// 새 명단 [m1,m2,m3,m4] — 기존 연결 셋은 전부 허용 유지.
		const rtpart = { memberIds: ["m1", "m2", "m3", "m4"] };
		expect(connectionsToClose(conns, rtpart, { sharedReadOnly: true })).toEqual([]);
	});

	it("멤버 제거는 그 멤버의 연결만 닫음", () => {
		const rtpart = { memberIds: ["m1", "m3"] }; // m2 제거
		const closed = connectionsToClose(conns, rtpart, { sharedReadOnly: true });
		expect(closed.map((c) => c.ref)).toEqual(["m2"]);
	});

	it("읽기전용 켜짐 + rtpart 없음 → 멤버 전원 닫힘(manager는 유지)", () => {
		const mixed = [conn("m1"), { ref: "t1", claims: manager, room: room("g1") }];
		const closed = connectionsToClose(mixed, null, { sharedReadOnly: true });
		expect(closed.map((c) => c.ref)).toEqual(["m1"]); // manager는 닫히지 않음
	});

	it("지정문서 삭제(deleted) + 전원허용(rtcontrol off)이면 아무도 안 닫힘", () => {
		const rtpart = { memberIds: ["m1"], deleted: true };
		expect(connectionsToClose(conns, rtpart, { sharedReadOnly: false })).toEqual([]);
	});

	it("claims/room이 없는 연결(인증 전 등)은 건드리지 않음", () => {
		const partial = [{ ref: "x" }, { ref: "y", claims: member("m9"), room: room("g1") }];
		const rtpart = { memberIds: ["m1"] }; // m9 비참여
		const closed = connectionsToClose(partial, rtpart, { sharedReadOnly: true });
		expect(closed.map((c) => c.ref)).toEqual(["y"]); // ref:x(컨텍스트 미상)는 제외
	});
});
