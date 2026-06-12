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

	it("구성원은 교사 전용 타입(게시물 메타 + 인가·명단)을 쓸 수 없다", () => {
		for (const type of ["notice", "timetable", "routine", "assignment", "chatgroup", "rtpart", "rtcontrol", "roster"]) {
			expect(() => validate({ type }, null, member)).toThrow();
		}
	});

	it("구성원은 협업 콘텐츠(note/asset/message/feedback)를 쓸 수 있다(읽기전용 꺼짐)", () => {
		for (const type of ["note", "asset", "message", "feedback"]) {
			expect(() => validate({ type, _id: `${type}:x.md` }, null, member)).not.toThrow();
		}
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

	it("message/feedback/response는 읽기전용과 무관하게 허용", () => {
		expect(() => validate({ type: "message", _id: "m1" }, null, other)).not.toThrow();
		expect(() => validate({ type: "feedback", _id: "f1" }, null, other)).not.toThrow();
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
