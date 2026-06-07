import { CoVaultSettings } from "./types";
import { foldersOverlap, isValidCouchName } from "../core/path/path";

export type IssueCode =
	| "dup-memberId"
	| "dup-username"
	| "dup-remoteDb"
	| "bad-memberId"
	| "bad-username"
	| "bad-remoteDb"
	| "bad-shareDb"
	| "folder-overlap"
	| "couch-url"
	| "yjs-wss"
	| "rt-no-url"
	| "rt-no-token";

export interface SettingsIssue {
	level: "error" | "warn";
	code: IssueCode;
	params?: Record<string, string | number>;
}

function duplicates(values: string[]): string[] {
	const seen = new Set<string>();
	const dup = new Set<string>();
	for (const v of values) (seen.has(v) ? dup.add(v) : seen.add(v));
	return [...dup];
}

export interface ValidateOptions {
	/**
	 * 실시간 자격증명(Yjs token/secret)이 런타임에 실제로 존재하는지. UI가 Secret Storage를 조회해 넘긴다.
	 * 주어지면 marker flag(yjs*Set) 대신 이 값으로 판단한다(지워진 Secret Storage를 marker가 가리지 않게).
	 * 미지정(undefined)이면 marker 휴리스틱을 쓴다(순수 호출/테스트 호환).
	 */
	realtimeCredPresent?: boolean;
}

/**
 * 설정의 위험/모순 상태를 코드로 반환(순수 함수, i18n은 UI에서). 초대/배포 전 막는 데 쓴다.
 * error=데이터 무결성 위험(중복 식별자), warn=권장 위반(겹침/URL/실시간 누락).
 */
export function validateSettings(s: CoVaultSettings, opts?: ValidateOptions): SettingsIssue[] {
	const issues: SettingsIssue[] = [];

	if (s.role === "manager") {
		const st = s.members;
		for (const id of duplicates(st.map((x) => x.memberId).filter((v): v is string => !!v)))
			issues.push({ level: "error", code: "dup-memberId", params: { value: id } });
		for (const u of duplicates(st.map((x) => x.username).filter((v): v is string => !!v)))
			issues.push({ level: "error", code: "dup-username", params: { value: u } });
		for (const db of duplicates(st.map((x) => x.remoteDb).filter((v): v is string => !!v)))
			issues.push({ level: "error", code: "dup-remoteDb", params: { value: db } });

		// CouchDB 이름 형식(소문자·숫자·_·-). 값이 있을 때만 검사 — 프로비저닝 전에 막는다.
		for (const x of st) {
			if (x.memberId && !isValidCouchName(x.memberId))
				issues.push({ level: "error", code: "bad-memberId", params: { value: x.memberId } });
			if (x.username && !isValidCouchName(x.username))
				issues.push({ level: "error", code: "bad-username", params: { value: x.username } });
			if (x.remoteDb && !isValidCouchName(x.remoteDb))
				issues.push({ level: "error", code: "bad-remoteDb", params: { value: x.remoteDb } });
		}
		for (const sp of s.sharedSpaces)
			if (sp.remoteDb && !isValidCouchName(sp.remoteDb))
				issues.push({ level: "error", code: "bad-shareDb", params: { value: sp.remoteDb } });

		// 학생 폴더 간 + 학생↔공유 폴더 겹침(이중 동기화 혼란 방지)
		const folders = [
			...st.map((x) => ({ label: x.memberName || x.memberId, path: x.localRoot })),
			...s.sharedSpaces.map((sp) => ({ label: sp.name || sp.id, path: sp.folder })),
		].filter((f) => f.path);
		for (let i = 0; i < folders.length; i++)
			for (let j = i + 1; j < folders.length; j++)
				if (foldersOverlap(folders[i].path, folders[j].path))
					issues.push({ level: "warn", code: "folder-overlap", params: { a: folders[i].label, b: folders[j].label } });
	}

	if (s.couchdbUrl && !/^https?:\/\//i.test(s.couchdbUrl))
		issues.push({ level: "warn", code: "couch-url" });

	if (s.yjsServerUrl && !/^wss:\/\//i.test(s.yjsServerUrl)) issues.push({ level: "warn", code: "yjs-wss" });

	if (s.realtimeEnabled) {
		if (!s.yjsServerUrl) issues.push({ level: "warn", code: "rt-no-url" });
		else {
			// UI가 런타임 자격증명 존재 여부를 넘기면 그것을 신뢰한다(Secret Storage가 비었는데 marker만 남은 경우 대비).
			// 미지정이면 평문/marker 휴리스틱으로 판단.
			const hasCred = opts?.realtimeCredPresent ?? !!(s.yjsSecret || s.yjsSecretSet);
			if (!hasCred) issues.push({ level: "warn", code: "rt-no-token" });
		}
	}

	return issues;
}
