/**
 * 경로 매핑 규칙. 기술문서 §9.
 *
 * DB path는 항상 학생 vault 기준 상대 경로(POSIX, 슬래시 구분)다.
 * - Member Mode: localPath = join(localRoot, dbPath)
 * - Manager Mode: localPath = join(member.localRoot, dbPath)
 */

/** 슬래시 정규화 + 앞뒤 슬래시 제거. */
export function normalizePath(p: string): string {
	return p
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}

/**
 * DB path 유효성 검사 (기술문서 §9.1 금지 목록).
 * 상위 경로 탈출(..), 절대 경로, 드라이브 경로, 플러그인 내부 경로를 거부한다.
 */
export function validateVaultPath(dbPath: string): boolean {
	if (!dbPath) return false;
	const p = dbPath.replace(/\\/g, "/");
	if (p.startsWith("/")) return false; // 절대 경로
	if (/^[a-zA-Z]:/.test(p)) return false; // C:\...
	if (p.split("/").some((seg) => seg === "..")) return false; // 상위 탈출
	if (p === ".obsidian" || p.startsWith(".obsidian/")) return false; // 플러그인 내부(단독 경로 포함)
	return true;
}

/**
 * 충돌/백업 사본 이름: 파일명의 마지막 확장자 **앞**에 `.label`을 끼운다.
 * ex) `a/b.png` + `학생A` → `a/b.학생A.png`, `notes/day.md` → `notes/day.학생A.md`, `README` → `README.학생A`.
 * (바이너리에 `.md`가 덧붙어 마크다운으로 오인되던 문제를 막는다.)
 */
export function insertLabelBeforeExt(dbPath: string, label: string): string {
	const slash = dbPath.lastIndexOf("/");
	const dir = slash >= 0 ? dbPath.slice(0, slash + 1) : "";
	const base = slash >= 0 ? dbPath.slice(slash + 1) : dbPath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return `${dir}${base}.${label}`; // 확장자 없음 또는 숨김파일(.x) → 뒤에 붙임
	return `${dir}${base.slice(0, dot)}.${label}${base.slice(dot)}`;
}

/** 사용자 입력 폴더 경로 검증(빈 값/`..`/절대경로/드라이브/.obsidian 차단). validateVaultPath와 동일 규칙. */
export function validateFolderName(folder: string): boolean {
	return validateVaultPath(folder);
}

/**
 * CouchDB DB/계정 이름으로 안전한지(보수적 규칙: 소문자·숫자로 시작, 이후 소문자·숫자·`_`·`-`).
 * 학생 ID/계정/Mirror·공유 DB 이름에 적용해, 프로비저닝 HTTP 에러 전에 설정 단계에서 막는다(보고서 권장).
 * 빈 값은 검사 대상이 아니다(호출 측에서 제외).
 */
export function isValidCouchName(name: string): boolean {
	return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

/** 두 폴더 경로가 같거나 한쪽이 다른 쪽을 포함(중첩)하면 true. 빈 값은 겹침 아님. */
export function foldersOverlap(a: string, b: string): boolean {
	const x = normalizePath(a);
	const y = normalizePath(b);
	if (!x || !y) return false;
	if (x === y) return true;
	return x.startsWith(y + "/") || y.startsWith(x + "/");
}

/** 경로 세그먼트 안전 결합. 빈 root는 무시. */
export function safeJoin(...parts: string[]): string {
	return normalizePath(parts.filter((x) => x && x.length > 0).join("/"));
}

/** DB path → local vault path (localRoot 아래로 매핑). */
export function dbPathToLocal(localRoot: string, dbPath: string): string {
	return safeJoin(localRoot, dbPath);
}

/**
 * local vault path → DB path (localRoot 접두 제거).
 * localRoot 밖의 경로면 null (기술문서 §9.4 폴더 밖 변경 무시).
 */
export function localPathToDb(localRoot: string, localPath: string): string | null {
	const root = normalizePath(localRoot);
	const local = normalizePath(localPath);
	if (root === "") return local;
	if (local === root) return "";
	if (local.startsWith(root + "/")) return local.slice(root.length + 1);
	return null;
}
