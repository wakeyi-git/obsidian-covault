import { READONLY_FORBIDDEN_REASON } from "../couch/validatePolicy";

/**
 * PouchDB replication 'denied' 이벤트 해석(순수). 서버 validate가 거부한 문서를 식별한다.
 * 페이로드 형태가 어댑터·버전에 따라 다양({doc:{id,error,reason}} / {id,reason} / 중첩 배열 등)해서
 * 제한 깊이로 방어적으로 훑는다. 읽기전용 거부는 validatePolicy의 사유 문자열 프로토콜로 판별.
 */
export interface DeniedInfo {
	/** 거부된 문서 id(예: note:<dbPath>). 찾지 못하면 undefined. */
	id?: string;
	/** 공유 읽기전용 정책(covault:shared-read-only)에 의한 거부인가. */
	sharedReadOnly: boolean;
}

export function parseDeniedEvent(e: unknown): DeniedInfo {
	const seen = new Set<unknown>();
	let id: string | undefined;
	let sharedReadOnly = false;
	const visit = (v: unknown, depth: number): void => {
		if (depth > 4 || typeof v !== "object" || v === null || seen.has(v)) return;
		seen.add(v);
		const o = v as Record<string, unknown>;
		if (!id && typeof o.id === "string") id = o.id;
		if (!id && typeof o._id === "string") id = o._id;
		for (const key of ["reason", "message", "name", "error"]) {
			const val = o[key];
			if (typeof val === "string" && val.includes(READONLY_FORBIDDEN_REASON)) sharedReadOnly = true;
		}
		for (const val of Object.values(o)) visit(val, depth + 1);
	};
	visit(e, 0);
	return { id, sharedReadOnly };
}

/** 거부 문서 id에서 사용자에게 보여줄 경로를 추출(note:/asset: 프리픽스 제거). */
export function deniedDisplayPath(id: string | undefined): string {
	if (!id) return "?";
	if (id.startsWith("note:")) return id.slice("note:".length);
	if (id.startsWith("asset:")) return id.slice("asset:".length);
	return id;
}
