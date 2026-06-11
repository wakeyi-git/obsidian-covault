import { describe, it, expect } from "vitest";
import { localizeDefaultFolders } from "./localizeDefaults";
import { DEFAULT_SETTINGS, CoVaultSettings } from "./types";

describe("localizeDefaultFolders (M-18)", () => {
	const fresh = (): CoVaultSettings => ({ ...DEFAULT_SETTINGS });

	it("en 로케일 신규 설치는 영문 기본 폴더명으로", () => {
		const s = fresh();
		expect(localizeDefaultFolders(s, "en")).toBe(true);
		expect(s.archiveFolder).toBe("_deleted");
		expect(s.conflictFolder).toBe("_conflicts");
	});

	it("ko 로케일은 기본값 유지", () => {
		const s = fresh();
		expect(localizeDefaultFolders(s, "ko")).toBe(false);
		expect(s.archiveFolder).toBe("_삭제됨");
		expect(s.conflictFolder).toBe("_충돌");
	});

	it("사용자가 이미 바꾼 폴더명은 건드리지 않는다", () => {
		const s = { ...fresh(), archiveFolder: "trash" };
		expect(localizeDefaultFolders(s, "en")).toBe(true); // conflictFolder만 전환
		expect(s.archiveFolder).toBe("trash");
		expect(s.conflictFolder).toBe("_conflicts");
	});
});
