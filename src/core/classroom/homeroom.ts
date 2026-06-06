import { SharedSpace } from "../../settings/types";

/** 공유 공간 목록에서 학급 공동 공간(kind="homeroom")을 찾는다. 없으면 undefined. */
export function findHomeroom(spaces: SharedSpace[]): SharedSpace | undefined {
	return spaces.find((s) => s.kind === "homeroom");
}

/**
 * spaceId를 학급 공동 공간으로 지정한다(나머지 공간의 homeroom 지정은 해제). spaceId=null이면 전체 해제.
 * 학급 운영 기능(알림장·수업안내·과제 공유 등)은 이 공간의 폴더/DB를 기준으로 동작한다.
 */
export function setHomeroom(spaces: SharedSpace[], spaceId: string | null): SharedSpace[] {
	return spaces.map((s) => {
		if (s.id === spaceId) return { ...s, kind: "homeroom" as const };
		if (s.kind === "homeroom") {
			const next = { ...s };
			delete next.kind;
			return next;
		}
		return s;
	});
}
