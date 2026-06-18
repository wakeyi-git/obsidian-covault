// validate_doc_update v3 — 정책 임베드형 소스를 직접 평가해 검증한다(기존 validateDoc.test.ts의 v2 회귀 포함).
import { describe, it, expect } from "vitest";
import { buildValidateSource, policyFingerprint, allowMapFromRtParts, ValidatePolicy, READONLY_FORBIDDEN_REASON } from "./validatePolicy";

type Validate = (newDoc: any, oldDoc: any, userCtx: any) => void;
function compile(policy: ValidatePolicy): Validate {
	return new Function(`return (${buildValidateSource(policy)})`)() as Validate;
}

const member = { name: "student_a", roles: [] };
const other = { name: "student_b", roles: [] };
const svc = { name: "covault-rt", roles: [] };
const admin = { name: "teacher", roles: ["_admin"] };

const OFF: ValidatePolicy = { readOnly: false, allowByPath: {} };
const RO: ValidatePolicy = {
	readOnly: true,
	svcUsername: "covault-rt",
	allowByPath: { "모둠활동/토론.md": ["student_a"], "잠금.md": [] },
};

describe("validate v2 규칙 회귀 (정책과 무관하게 유지)", () => {
	const validate = compile(OFF);

	it("admin(교사)은 모든 타입을 우회한다", () => {
		for (const type of ["notice", "rtpart", "rtcontrol", "chatgroup", "roster", "grouprequest"]) {
			expect(() => validate({ type, status: "approved" }, null, admin)).not.toThrow();
		}
	});

	it("구성원은 교사 전용 타입(게시물 메타 + 인가·명단 + shares/rtconfig)을 쓸 수 없다", () => {
		for (const type of ["notice", "timetable", "routine", "assignment", "chatgroup", "rtpart", "rtcontrol", "roster", "shares", "rtconfig"]) {
			expect(() => validate({ type }, null, member)).toThrow();
		}
	});

	it("구성원은 note/asset를 자유롭게 쓸 수 있다(읽기전용 꺼짐)", () => {
		for (const type of ["note", "asset"]) {
			expect(() => validate({ type, _id: `${type}:x.md` }, null, member)).not.toThrow();
		}
	});

	it("구성원은 본인 명의(member 역할) message/feedback를 쓸 수 있다", () => {
		expect(() => validate({ type: "message", _id: "message:1", byUser: "student_a", byRole: "member" }, null, member)).not.toThrow();
		expect(() => validate({ type: "feedback", _id: "feedback:1", createdBy: "student_a", createdByRole: "member" }, null, member)).not.toThrow();
	});

	it("grouprequest: 본인 pending 신청 허용·soft-취소 허용·타인/승인 위조 거부", () => {
		expect(() => validate({ type: "grouprequest", byUsername: "student_a", status: "pending" }, null, member)).not.toThrow();
		const old = { type: "grouprequest", byUsername: "student_a", status: "pending" };
		expect(() => validate({ ...old, deleted: true }, old, member)).not.toThrow();
		expect(() => validate({ type: "grouprequest", byUsername: "student_b", status: "pending" }, null, member)).toThrow();
		expect(() => validate({ type: "grouprequest", byUsername: "student_a", status: "approved" }, null, member)).toThrow();
	});

	it("response는 본인 것만", () => {
		expect(() => validate({ type: "response", byUser: "student_a" }, null, member)).not.toThrow();
		expect(() => validate({ type: "response", byUser: "student_b" }, null, member)).toThrow();
	});

	it("ystate(실시간 CRDT 상태)는 서비스 계정만 쓴다(구성원 위조 거부, admin 우회)", () => {
		const v = compile({ readOnly: false, svcUsername: "covault-rt", allowByPath: {} });
		expect(() => v({ type: "ystate", _id: "ystate:x.md", state: "..." }, null, svc)).not.toThrow();
		expect(() => v({ type: "ystate", _id: "ystate:x.md", state: "..." }, null, member)).toThrow();
		expect(() => v({ type: "ystate", _id: "ystate:x.md", state: "..." }, null, admin)).not.toThrow();
		// svc 미설정이면 비-admin은 전부 거부(서버는 admin 자격으로 우회).
		const noSvc = compile({ readOnly: false, allowByPath: {} });
		expect(() => noSvc({ type: "ystate", _id: "ystate:x.md" }, null, member)).toThrow();
		expect(() => noSvc({ type: "ystate", _id: "ystate:x.md" }, null, admin)).not.toThrow();
	});

	it("message: 본인 것만 + manager 역할 위조 거부 + 타인 메시지 수정/삭제 거부 (P1-1)", () => {
		// 본인 명의 신규
		expect(() => validate({ type: "message", _id: "message:1", byUser: "student_a", byRole: "member" }, null, member)).not.toThrow();
		// 타 멤버 명의로 작성
		expect(() => validate({ type: "message", _id: "message:2", byUser: "student_b", byRole: "member" }, null, member)).toThrow();
		// 운영자(manager) 역할 위조
		expect(() => validate({ type: "message", _id: "message:3", byUser: "student_a", byRole: "manager" }, null, member)).toThrow();
		// byUser 누락(불완전 문서) 거부
		expect(() => validate({ type: "message", _id: "message:4", byRole: "member" }, null, member)).toThrow();
		// 본인 메시지 수정(soft delete) 허용
		const own = { type: "message", _id: "message:1", byUser: "student_a", byRole: "member" };
		expect(() => validate({ ...own, deleted: true }, own, member)).not.toThrow();
		// 타인 메시지 수정/삭제(기존 문서 owner=타인) 거부
		const others = { type: "message", _id: "message:9", byUser: "student_b", byRole: "member" };
		expect(() => validate({ ...others, body: "변조" }, others, member)).toThrow();
		// 타인 메시지 hard delete(_deleted, newDoc owner 없음 → oldDoc owner=타인) 거부
		expect(() => validate({ _id: "message:9", _deleted: true }, others, member)).toThrow();
		// 본인 메시지 hard delete 허용
		expect(() => validate({ _id: "message:1", _deleted: true }, own, member)).not.toThrow();
	});

	it("feedback: 본인 것만 + manager 역할 위조 거부 (P1-1)", () => {
		expect(() => validate({ type: "feedback", _id: "feedback:1", createdBy: "student_a", createdByRole: "member" }, null, member)).not.toThrow();
		expect(() => validate({ type: "feedback", _id: "feedback:2", createdBy: "student_b", createdByRole: "member" }, null, member)).toThrow();
		expect(() => validate({ type: "feedback", _id: "feedback:3", createdBy: "student_a", createdByRole: "manager" }, null, member)).toThrow();
		expect(() => validate({ type: "feedback", _id: "feedback:4", createdByRole: "member" }, null, member)).toThrow();
	});

	it("운영자(_admin)는 message/feedback 소유·역할 검사를 우회한다", () => {
		expect(() => validate({ type: "message", _id: "m1", byUser: "anyone", byRole: "manager" }, null, admin)).not.toThrow();
		expect(() => validate({ type: "feedback", _id: "f1", createdBy: "anyone", createdByRole: "manager" }, null, admin)).not.toThrow();
	});
});

describe("validate v3 — 읽기전용 강제 (H-5)", () => {
	const validate = compile(RO);

	it("참여자는 자기 파일 note 쓰기 허용(세션 종료 보증 업로드 경로)", () => {
		expect(() => validate({ type: "note", _id: "note:모둠활동/토론.md" }, null, member)).not.toThrow();
	});

	it("비참여자·타 파일은 거부(사유 프로토콜 포함)", () => {
		try {
			validate({ type: "note", _id: "note:모둠활동/토론.md" }, null, other);
			expect.unreachable();
		} catch (e: any) {
			expect(e.forbidden).toBe(READONLY_FORBIDDEN_REASON);
		}
		expect(() => validate({ type: "note", _id: "note:다른파일.md" }, null, member)).toThrow();
	});

	it("빈 참여자 배열 = 아무도 못 씀(명시적 차단)", () => {
		expect(() => validate({ type: "note", _id: "note:잠금.md" }, null, member)).toThrow();
	});

	it("note tombstone(앱 수준 deleted 갱신)도 같은 규칙 — oldDoc._id 폴백", () => {
		const old = { type: "note", _id: "note:모둠활동/토론.md", deleted: false };
		expect(() => validate({ ...old, deleted: true }, old, member)).not.toThrow();
		expect(() => validate({ ...old, deleted: true }, old, other)).toThrow();
	});

	it("서비스 계정(서버 스냅샷)은 항상 허용", () => {
		expect(() => validate({ type: "note", _id: "note:다른파일.md" }, null, svc)).not.toThrow();
		expect(() => validate({ type: "asset", _id: "asset:img.png" }, null, svc)).not.toThrow();
	});

	it("asset은 참여자 합집합 허용(Excalidraw 이미지 절충)", () => {
		expect(() => validate({ type: "asset", _id: "asset:그림.png" }, null, member)).not.toThrow(); // 어딘가의 참여자
		expect(() => validate({ type: "asset", _id: "asset:그림.png" }, null, other)).toThrow();
	});

	it("message/feedback/response는 읽기전용과 무관하게 본인 명의면 허용", () => {
		expect(() => validate({ type: "message", _id: "m1", byUser: "student_b", byRole: "member" }, null, other)).not.toThrow();
		expect(() => validate({ type: "feedback", _id: "f1", createdBy: "student_b", createdByRole: "member" }, null, other)).not.toThrow();
		expect(() => validate({ type: "response", byUser: "student_b" }, null, other)).not.toThrow();
	});

	it("admin은 읽기전용에서도 우회", () => {
		expect(() => validate({ type: "note", _id: "note:잠금.md" }, null, admin)).not.toThrow();
	});
});

describe("policyFingerprint / allowMapFromRtParts", () => {
	it("지문은 키·값 순서와 무관하게 결정적", async () => {
		const a: ValidatePolicy = { readOnly: true, svcUsername: "svc", allowByPath: { "b.md": ["y", "x"], "a.md": ["z"] } };
		const b: ValidatePolicy = { readOnly: true, svcUsername: "svc", allowByPath: { "a.md": ["z"], "b.md": ["x", "y"] } };
		expect(await policyFingerprint(a)).toBe(await policyFingerprint(b));
		const c: ValidatePolicy = { ...a, readOnly: false };
		expect(await policyFingerprint(a)).not.toBe(await policyFingerprint(c));
	});

	it("allowMap(v4): memberId 그대로 임베드, 명단 밖·삭제 문서 제외, 빈 배열 유지", () => {
		const members = [{ memberId: "m1" }, { memberId: "m2" }];
		const map = allowMapFromRtParts(
			[
				{ dbPath: "토론.md", memberIds: ["m2", "m1", "ghost"] },
				{ dbPath: "삭제됨.md", memberIds: ["m1"], deleted: true },
				{ dbPath: "잠금.md", memberIds: [] },
			],
			members,
		);
		expect(map).toEqual({ "토론.md": ["m1", "m2"], "잠금.md": [] });
	});

	it("지문은 accounts 맵 변경에도 반응한다(기기 계정 추가 → 재배포)", async () => {
		const base: ValidatePolicy = { readOnly: false, allowByPath: {}, accounts: { student_a: "m1" } };
		const withDevice: ValidatePolicy = { ...base, accounts: { student_a: "m1", "m1-d2": "m1" } };
		expect(await policyFingerprint(base)).not.toBe(await policyFingerprint(withDevice));
	});
});

describe("validate v4 — 기기별 계정(acct 정규화, 평가 S-2)", () => {
	// m1의 계정: student_a(기본) + m1-d2(기기). 허용 목록·소유 필드는 memberId 기준.
	const policy: ValidatePolicy = {
		readOnly: true,
		svcUsername: "covault-rt",
		allowByPath: { "모둠활동/토론.md": ["m1"], "잠금.md": [] },
		accounts: { student_a: "m1", "m1-d2": "m1", student_b: "m2" },
	};
	const validate = compile(policy);
	const device = { name: "m1-d2", roles: [] };

	it("기기 계정도 기본 계정과 동일하게 참여 파일 note 쓰기 허용", () => {
		expect(() => validate({ type: "note", _id: "note:모둠활동/토론.md" }, null, member)).not.toThrow();
		expect(() => validate({ type: "note", _id: "note:모둠활동/토론.md" }, null, device)).not.toThrow();
		expect(() => validate({ type: "note", _id: "note:모둠활동/토론.md" }, null, other)).toThrow();
	});

	it("asset 합집합 허용도 기기 계정에 적용", () => {
		expect(() => validate({ type: "asset", _id: "asset:그림.png" }, null, device)).not.toThrow();
		expect(() => validate({ type: "asset", _id: "asset:그림.png" }, null, other)).toThrow();
	});

	it("response 소유 검사: byUser(memberId) 문서를 같은 구성원의 다른 기기에서 갱신 가능", () => {
		expect(() => validate({ type: "response", byUser: "m1" }, null, device)).not.toThrow();
		expect(() => validate({ type: "response", byUser: "m1" }, null, member)).not.toThrow();
		expect(() => validate({ type: "response", byUser: "m1" }, null, other)).toThrow();
	});

	it("grouprequest: 기기 A(기본 계정)가 만든 신청을 기기 B에서 soft-취소 가능 — 타인은 불가", () => {
		const old = { type: "grouprequest", byUsername: "student_a", status: "pending" };
		expect(() => validate({ ...old, deleted: true }, old, device)).not.toThrow();
		expect(() => validate({ ...old, deleted: true }, old, other)).toThrow();
	});
});

describe("mirror DB 정책 — DM 사칭 차단 (P1-1)", () => {
	// mirror는 readOnly:false(공유 공간 전용 개념). byUser는 memberId, 계정→memberId는 accounts로 정규화.
	const policy: ValidatePolicy = {
		readOnly: false,
		svcUsername: "covault-rt",
		allowByPath: {},
		accounts: { student_a: "m1", "m1-d2": "m1" }, // m1의 기본 계정 + 기기 계정
	};
	const validate = compile(policy);
	const m1 = { name: "student_a", roles: [] };
	const m1Device = { name: "m1-d2", roles: [] };
	const teacher = { name: "teacher", roles: ["_admin"] };

	it("구성원은 본인(memberId) 명의 DM을 보낼 수 있다 — 기기 계정도 동일", () => {
		expect(() => validate({ type: "message", _id: "message:1", channel: "dm:m1", byUser: "m1", byRole: "member" }, null, m1)).not.toThrow();
		expect(() => validate({ type: "message", _id: "message:2", channel: "dm:m1", byUser: "m1", byRole: "member" }, null, m1Device)).not.toThrow();
	});

	it("구성원은 자기 mirror DM에서도 운영자(manager) 명의를 위조할 수 없다", () => {
		expect(() => validate({ type: "message", _id: "message:3", channel: "dm:m1", byUser: "m1", byRole: "manager" }, null, m1)).toThrow();
	});

	it("운영자(_admin)는 mirror에 manager 명의 DM을 보낼 수 있다(우회)", () => {
		expect(() => validate({ type: "message", _id: "message:4", channel: "dm:m1", byUser: "manager", byRole: "manager" }, null, teacher)).not.toThrow();
	});

	it("구성원은 note/asset(자기 vault)·assignment-state·version을 자유롭게 쓴다 — mirror는 읽기전용 아님", () => {
		for (const type of ["note", "asset", "assignment-state", "routine-state", "version"]) {
			expect(() => validate({ type, _id: `${type}:x` }, null, m1)).not.toThrow();
		}
	});

	it("구성원은 mirror에 shares/rtconfig·기타 교사 전용 타입을 주입할 수 없다", () => {
		for (const type of ["shares", "rtconfig", "notice", "rtpart"]) {
			expect(() => validate({ type, _id: `${type}:x` }, null, m1)).toThrow();
		}
	});
});
