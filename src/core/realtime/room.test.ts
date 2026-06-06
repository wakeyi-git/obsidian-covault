import { describe, it, expect } from "vitest";
import { relUnder, roomName, pickSpace } from "./room";

describe("relUnder", () => {
	it("folder='' 이면 전체 경로를 그대로 반환(학생 vault 전체 mirror)", () => {
		expect(relUnder("note.md", "")).toBe("note.md");
		expect(relUnder("sub/a.md", "")).toBe("sub/a.md");
	});

	it("folder 아래면 오프셋된 상대경로", () => {
		expect(relUnder("학생A/note.md", "학생A")).toBe("note.md");
		expect(relUnder("학생A/sub/a.md", "학생A")).toBe("sub/a.md");
	});

	it("folder 자기 자신은 빈 문자열, 아래가 아니면 null", () => {
		expect(relUnder("학생A", "학생A")).toBe("");
		expect(relUnder("학생B/note.md", "학생A")).toBeNull();
		expect(relUnder("학생A2/note.md", "학생A")).toBeNull(); // prefix 오탐 방지
	});
});

describe("roomName — 교사/학생 패리티", () => {
	it("교사(folder='학생A')와 학생(folder='')이 같은 mirror room을 산출", () => {
		const teacher = roomName("c1", "mirror-s1", "학생A/note.md", "학생A");
		const student = roomName("c1", "mirror-s1", "note.md", "");
		expect(teacher).toBe("ws_c1/share/mirror-s1/note.md");
		expect(student).toBe(teacher);
	});

	it("하위 폴더도 양측 동일", () => {
		expect(roomName("c1", "mirror-s1", "학생A/sub/a.md", "학생A")).toBe(
			roomName("c1", "mirror-s1", "sub/a.md", ""),
		);
	});

	it("공유 공간 room과 네임스페이스가 같음(서버 prefix 무변경)", () => {
		expect(roomName("c1", "g1", "모둠1/x.md", "모둠1")).toBe("ws_c1/share/g1/x.md");
	});

	it("folder 밖이면 null", () => {
		expect(roomName("c1", "g1", "다른/x.md", "모둠1")).toBeNull();
	});
});

describe("pickSpace — longest-prefix + 빈 folder 정책", () => {
	const mirror = { id: "mirror-s1", folder: "", kind: "mirror" as const };
	const shared = { id: "g1", folder: "모둠1", kind: "share" as const };
	const none = () => false;

	it("공유 폴더 하위 경로는 mirror가 있어도 공유 공간으로 라우팅(가장 긴 folder 승)", () => {
		expect(pickSpace([mirror, shared], "모둠1/x.md", none)).toBe(shared);
	});

	it("공유 폴더 밖 경로는 mirror(fallback)로", () => {
		expect(pickSpace([mirror, shared], "노트.md", none)).toBe(mirror);
	});

	it("빈 folder인데 kind!=='mirror'면 무시(잘못된 share가 vault 전체를 삼키지 않음)", () => {
		const badShare = { id: "bad", folder: "", kind: "share" as const };
		expect(pickSpace([badShare], "노트.md", none)).toBeNull();
	});

	it("제외(보관/충돌)면 해당 공간 매치 제외 → 매치 없으면 null", () => {
		expect(pickSpace([mirror], "_삭제됨/x.md", () => true)).toBeNull();
	});

	it("공간이 없으면 null", () => {
		expect(pickSpace([], "노트.md", none)).toBeNull();
	});
});
