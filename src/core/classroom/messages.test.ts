import { describe, it, expect } from "vitest";
import { parseMessageBody } from "./messages";

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
