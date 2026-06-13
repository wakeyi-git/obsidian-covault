import { describe, it, expect } from "vitest";
import { parseMessageBody, messageListSig, isAppendable, messageSnippet } from "./messages";

describe("parseMessageBody", () => {
	it("순수 텍스트는 그대로", () => {
		expect(parseMessageBody("안녕하세요")).toEqual([{ kind: "text", text: "안녕하세요" }]);
	});

	it("위키링크/임베드/표시명·헤딩 처리", () => {
		expect(parseMessageBody("[[수학노트]] 보세요")).toEqual([
			{ kind: "wikilink", target: "수학노트", embed: false, raw: "[[수학노트]]" },
			{ kind: "text", text: " 보세요" },
		]);
		expect(parseMessageBody("![[그림.png]]")).toEqual([
			{ kind: "wikilink", target: "그림.png", embed: true, raw: "![[그림.png]]" },
		]);
		expect(parseMessageBody("[[노트|별칭#섹션]]")[0]).toMatchObject({ kind: "wikilink", target: "노트" });
	});

	it("URL을 분리", () => {
		const segs = parseMessageBody("자료: https://example.com/a 끝");
		expect(segs).toEqual([
			{ kind: "text", text: "자료: " },
			{ kind: "url", url: "https://example.com/a" },
			{ kind: "text", text: " 끝" },
		]);
	});

	it("혼합", () => {
		const segs = parseMessageBody("[[안내]] 와 https://x.io 참고");
		expect(segs.map((s) => s.kind)).toEqual(["wikilink", "text", "url", "text"]);
	});

	it("멘션 @[이름]", () => {
		const segs = parseMessageBody("@[김유민] 확인해줘");
		expect(segs).toEqual([
			{ kind: "mention", name: "김유민", raw: "@[김유민]" },
			{ kind: "text", text: " 확인해줘" },
		]);
	});

	it("피드백 ((fb|경로|uid|라벨))", () => {
		const segs = parseMessageBody("여기 ((fb|모둠활동/1모둠.md|abc123|3번째 줄)) 봐");
		expect(segs[1]).toEqual({
			kind: "feedback",
			path: "모둠활동/1모둠.md",
			uid: "abc123",
			label: "3번째 줄",
			raw: "((fb|모둠활동/1모둠.md|abc123|3번째 줄))",
		});
		expect(segs.map((s) => s.kind)).toEqual(["text", "feedback", "text"]);
	});
});

describe("messageListSig (P2-6 — 폴링 변화 판정)", () => {
	const m = (id: string, rev?: string) => ({ _id: id, _rev: rev });
	it("길이·머리·꼬리 id·꼬리 rev로 결정적", () => {
		expect(messageListSig("class", 30, [m("a"), m("b", "2-x")])).toBe("class|30|2|a|b|2-x");
		expect(messageListSig("class", 30, [])).toBe("class|30|0||"+"|"); // 빈 목록
	});
	it("꼬리 내용 변경(같은 id, 다른 rev)도 변화로 잡는다", () => {
		const before = messageListSig("dm:m1", 30, [m("a"), m("b", "1-x")]);
		const after = messageListSig("dm:m1", 30, [m("a"), m("b", "2-y")]);
		expect(before).not.toBe(after);
	});
	it("채널·창 크기 변경도 변화", () => {
		expect(messageListSig("a", 30, [m("x")])).not.toBe(messageListSig("b", 30, [m("x")]));
		expect(messageListSig("a", 30, [m("x")])).not.toBe(messageListSig("a", 60, [m("x")]));
	});
});

describe("isAppendable (P2-6 — append-only 판정)", () => {
	it("기존이 새 목록의 prefix면 true(꼬리만 추가)", () => {
		expect(isAppendable(["a", "b"], ["a", "b", "c"])).toBe(true);
	});
	it("길이 같거나 줄면 false(추가할 것 없음·삭제)", () => {
		expect(isAppendable(["a", "b"], ["a", "b"])).toBe(false);
		expect(isAppendable(["a", "b", "c"], ["a", "b"])).toBe(false);
	});
	it("머리가 바뀌면 false(창 미끄러짐·이전 로드 → 전체 재구성)", () => {
		expect(isAppendable(["a", "b"], ["b", "c", "d"])).toBe(false);
		expect(isAppendable(["a", "b"], ["x", "b", "c"])).toBe(false);
	});
	it("빈 기존 목록이면 false(첫 렌더는 전체 구성)", () => {
		expect(isAppendable([], ["a", "b"])).toBe(false);
	});
});

describe("messageSnippet (P2-6 — 링크/멘션 제거 미리보기)", () => {
	it("위키링크·멘션·URL 토큰을 텍스트로 평탄화", () => {
		expect(messageSnippet("[[수학노트]] 보세요 @[홍길동]")).toBe("수학노트 보세요 @홍길동");
	});
	it("max 초과 시 …로 자른다", () => {
		expect(messageSnippet("가나다라마바사", 4)).toBe("가나다…");
	});
	it("공백 정규화", () => {
		expect(messageSnippet("줄1\n\n  줄2")).toBe("줄1 줄2");
	});
});
