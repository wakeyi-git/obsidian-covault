import { describe, it, expect } from "vitest";
import { validateVaultPath, validateFolderName, validateExcludeFolder, foldersOverlap, insertLabelBeforeExt, uniqueGroupFolder } from "./path";

describe("validateVaultPath / validateFolderName", () => {
	it("정상 상대 경로는 허용", () => {
		expect(validateVaultPath("수업/1차시.md")).toBe(true);
		expect(validateFolderName("_삭제됨")).toBe(true);
	});

	it("빈 값/상위 탈출/절대경로/드라이브/.obsidian은 거부", () => {
		expect(validateFolderName("")).toBe(false);
		expect(validateFolderName("../비밀")).toBe(false);
		expect(validateFolderName("a/../b")).toBe(false);
		expect(validateFolderName("/etc")).toBe(false);
		expect(validateFolderName("C:/temp")).toBe(false);
		expect(validateFolderName(".obsidian/plugins")).toBe(false);
	});

	it(".obsidian 단독 경로도 거부", () => {
		expect(validateVaultPath(".obsidian")).toBe(false);
		expect(validateFolderName(".obsidian")).toBe(false);
	});
});

describe("validateExcludeFolder", () => {
	it("제외 목록은 .obsidian·.trash를 허용(기본값과 동일)", () => {
		expect(validateExcludeFolder(".obsidian")).toBe(true);
		expect(validateExcludeFolder(".obsidian/plugins")).toBe(true);
		expect(validateExcludeFolder(".trash")).toBe(true);
		expect(validateExcludeFolder("보관함")).toBe(true);
	});

	it("빈 값/상위 탈출/절대경로/드라이브는 여전히 거부", () => {
		expect(validateExcludeFolder("")).toBe(false);
		expect(validateExcludeFolder("../비밀")).toBe(false);
		expect(validateExcludeFolder("a/../b")).toBe(false);
		expect(validateExcludeFolder("/etc")).toBe(false);
		expect(validateExcludeFolder("C:/temp")).toBe(false);
	});
});

describe("insertLabelBeforeExt", () => {
	it("바이너리는 확장자 앞에 라벨을 넣는다(.md 덧붙이지 않음)", () => {
		expect(insertLabelBeforeExt("a/b.png", "학생A")).toBe("a/b.학생A.png");
	});

	it("마크다운은 기존과 동일하게 .md 앞에 라벨", () => {
		expect(insertLabelBeforeExt("notes/day.md", "학생A")).toBe("notes/day.학생A.md");
	});

	it("확장자 없으면 뒤에 붙인다", () => {
		expect(insertLabelBeforeExt("README", "학생A")).toBe("README.학생A");
		expect(insertLabelBeforeExt("dir/README", "학생A")).toBe("dir/README.학생A");
	});

	it("숨김파일(.x)은 확장자로 보지 않는다", () => {
		expect(insertLabelBeforeExt(".gitignore", "학생A")).toBe(".gitignore.학생A");
	});
});

describe("foldersOverlap", () => {
	it("같은 경로는 겹침", () => {
		expect(foldersOverlap("_삭제됨", "_삭제됨")).toBe(true);
	});

	it("한쪽이 다른 쪽을 포함하면 겹침", () => {
		expect(foldersOverlap("보관", "보관/하위")).toBe(true);
		expect(foldersOverlap("보관/하위", "보관")).toBe(true);
	});

	it("형제/무관 경로는 겹치지 않음", () => {
		expect(foldersOverlap("_삭제됨", "_충돌")).toBe(false);
		expect(foldersOverlap("보관", "보관2")).toBe(false);
	});

	it("빈 값은 겹침 아님", () => {
		expect(foldersOverlap("", "_충돌")).toBe(false);
		expect(foldersOverlap("_삭제됨", "")).toBe(false);
	});
});

describe("uniqueGroupFolder", () => {
	it("충돌 없으면 그대로", () => {
		expect(uniqueGroupFolder("모둠1", ["프로젝트", "학급"])).toBe("모둠1");
	});

	it("동일/중첩 폴더와 충돌하면 접미를 붙인다", () => {
		expect(uniqueGroupFolder("모둠1", ["모둠1"])).toBe("모둠1-2");
		expect(uniqueGroupFolder("모둠1", ["모둠1/하위"])).toBe("모둠1-2");
		expect(uniqueGroupFolder("모둠1", ["모둠1", "모둠1-2"])).toBe("모둠1-3");
	});

	it("정규화 후 비교한다", () => {
		expect(uniqueGroupFolder("모둠1/", ["모둠1"])).toBe("모둠1-2");
	});
});
