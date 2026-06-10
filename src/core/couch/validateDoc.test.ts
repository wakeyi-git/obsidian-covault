// 공유 DB validate_doc_update 규칙 검증 — CouchDB가 평가하는 함수 문자열을 직접 실행해 확인한다.
import { describe, it, expect } from "vitest";
import { VALIDATE_DOC_SOURCE } from "./CouchAdmin";

type Validate = (newDoc: any, oldDoc: any, userCtx: any) => void;
const validate = new Function(`return (${VALIDATE_DOC_SOURCE})`)() as Validate;

const member = { name: "student_a", roles: [] };
const admin = { name: "teacher", roles: ["_admin"] };

describe("validate_doc_update", () => {
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

	it("구성원은 협업 콘텐츠(note/asset/message/feedback)를 쓸 수 있다", () => {
		for (const type of ["note", "asset", "message", "feedback"]) {
			expect(() => validate({ type }, null, member)).not.toThrow();
		}
	});

	it("grouprequest: 본인 pending 신청은 허용", () => {
		expect(() => validate({ type: "grouprequest", byUsername: "student_a", status: "pending" }, null, member)).not.toThrow();
	});

	it("grouprequest: 본인 soft-취소(deleted, status 유지)는 허용", () => {
		const old = { type: "grouprequest", byUsername: "student_a", status: "pending" };
		expect(() => validate({ ...old, deleted: true }, old, member)).not.toThrow();
	});

	it("grouprequest: 타인 명의/타인 문서 수정은 거부", () => {
		expect(() => validate({ type: "grouprequest", byUsername: "student_b", status: "pending" }, null, member)).toThrow();
		const others = { type: "grouprequest", byUsername: "student_b", status: "pending" };
		expect(() => validate({ ...others, byUsername: "student_a" }, others, member)).toThrow();
	});

	it("grouprequest: 구성원의 승인/거절 위조(status)는 거부", () => {
		expect(() => validate({ type: "grouprequest", byUsername: "student_a", status: "approved" }, null, member)).toThrow();
		const old = { type: "grouprequest", byUsername: "student_a", status: "pending" };
		expect(() => validate({ ...old, status: "rejected" }, old, member)).toThrow();
	});

	it("response는 본인 것만(기존 규칙 유지)", () => {
		expect(() => validate({ type: "response", byUser: "student_a" }, null, member)).not.toThrow();
		expect(() => validate({ type: "response", byUser: "student_b" }, null, member)).toThrow();
	});
});
