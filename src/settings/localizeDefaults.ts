import { CoVaultSettings } from "./types";

/**
 * 신규 설치의 기본 폴더명과 표시 이름을 로케일에 맞춘다(비한국어). 순수 함수.
 * 최초 실행(역할 선택 전)에만 호출되므로 기존 사용자 값은 절대 바뀌지 않는다. 바꿨으면 true(호출자가 저장).
 *
 * - 폴더: `_삭제됨`→`_deleted`, `_충돌`→`_conflicts`.
 * - 표시 이름: 한국어 기본값 `구성원A`(= ko `common.member_a`)를 영문 기본값으로. 영어 관리자가
 *   한국어 기본명으로 노출되던 문제 해소(평가 P1-1). 값은 en `common.member_a`("Member A")와 맞춰야
 *   main.ts의 `displayName === t("common.member_a")` 비교가 매니저 전환 시 동작한다.
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
	if (s.displayName === "구성원A") {
		s.displayName = "Member A";
		changed = true;
	}
	return changed;
}
