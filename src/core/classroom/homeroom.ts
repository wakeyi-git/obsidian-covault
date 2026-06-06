import { SharedSpace } from "../../settings/types";

/** 학급(homeroom) 공유 공간의 고정 식별자. 대시보드(알림장·시간표·루틴 등) 학급 공통 콘텐츠를 담는다. */
export const HOMEROOM_ID = "homeroom";
export const HOMEROOM_DB = "share_homeroom";
export const HOMEROOM_FOLDER = "_학급";

/** 공유 공간 목록에서 학급 공간을 찾는다(없으면 undefined). */
export function findHomeroom(spaces: SharedSpace[]): SharedSpace | undefined {
	return spaces.find((s) => s.kind === "homeroom" || s.id === HOMEROOM_ID);
}

/**
 * 학급 공간을 찾거나 생성하고 전원 멤버로 맞춘다(순수). 반환된 spaces로 설정을 교체한다.
 * 기존 공간이 있으면 멤버만 갱신하고 kind/폴더/DB는 보존(이미 배포된 경우 안전).
 */
export function ensureHomeroomSpace(
	spaces: SharedSpace[],
	memberIds: string[],
	name: string,
): { space: SharedSpace; spaces: SharedSpace[] } {
	const members = [...memberIds];
	const idx = spaces.findIndex((s) => s.kind === "homeroom" || s.id === HOMEROOM_ID);
	if (idx >= 0) {
		const prev = spaces[idx];
		const space: SharedSpace = {
			...prev,
			kind: "homeroom",
			members,
			remoteDb: prev.remoteDb || HOMEROOM_DB,
			folder: prev.folder || HOMEROOM_FOLDER,
			name: prev.name || name,
		};
		const next = spaces.slice();
		next[idx] = space;
		return { space, spaces: next };
	}
	const space: SharedSpace = {
		id: HOMEROOM_ID,
		kind: "homeroom",
		name,
		remoteDb: HOMEROOM_DB,
		folder: HOMEROOM_FOLDER,
		members,
		realtime: true,
	};
	return { space, spaces: [...spaces, space] };
}
