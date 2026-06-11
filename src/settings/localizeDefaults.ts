import { CoVaultSettings } from "./types";

/**
 * 신규 설치의 기본 폴더명을 로케일에 맞춘다(비한국어 → `_deleted`/`_conflicts`). 순수 함수.
 * 최초 실행(역할 선택 전)에만 호출되므로 기존 사용자 폴더는 절대 바뀌지 않는다.
 * 바꿨으면 true(호출자가 저장).
 */
export function localizeDefaultFolders(s: CoVaultSettings, locale: "ko" | "en"): boolean {
	if (locale === "ko") return false;
	let changed = false;
	if (s.archiveFolder === "_삭제됨") {
		s.archiveFolder = "_deleted";
		changed = true;
	}
	if (s.conflictFolder === "_충돌") {
		s.conflictFolder = "_conflicts";
		changed = true;
	}
	return changed;
}
