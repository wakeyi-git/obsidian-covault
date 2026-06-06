/** 학생 명단 붙여넣기 파싱/정규화(순수 함수). 단위 테스트 가능. */

export interface RosterInput {
	name: string;
	/** 사용자가 명시한 ID(없으면 빈 문자열 → 자동 생성). */
	id: string;
}

export interface RosterEntry {
	name: string;
	id: string; // 최종(고유) ID
	remoteDb: string; // mirror_<id>
	adjusted: boolean; // 중복 회피로 ID가 조정됐는지
	emptyName: boolean; // 이름이 비어 추가 불가
}

function normId(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function slug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/**
 * 붙여넣은 텍스트를 한 줄 = 한 학생으로 파싱.
 * - `이름,ID` (쉼표) 또는 `이름 ID`(마지막 토큰이 ASCII id면 ID로) 또는 `이름`(ID 자동).
 * - 빈 줄·`#` 주석 줄은 건너뜀.
 */
export function parseMemberRoster(text: string): RosterInput[] {
	const out: RosterInput[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		let name = "";
		let id = "";
		const comma = line.indexOf(",");
		if (comma >= 0) {
			name = line.slice(0, comma).trim();
			id = line.slice(comma + 1).trim();
		} else {
			const parts = line.split(/\s+/);
			const last = parts[parts.length - 1];
			if (parts.length >= 2 && /^[a-zA-Z0-9_]+$/.test(last)) {
				id = last;
				name = parts.slice(0, -1).join(" ");
			} else {
				name = line;
			}
		}
		out.push({ name, id });
	}
	return out;
}

/**
 * 파싱 결과에 최종 ID를 부여한다. 명시 ID는 정규화, 없으면 이름 슬러그(없으면 'member').
 * 기존 ID + 배치 내에서 고유하도록 `_2`, `_3` … 접미사. CouchDB DB명도 함께 만든다.
 */
export function finalizeRoster(parsed: RosterInput[], existingIds: string[]): RosterEntry[] {
	const used = new Set(existingIds);
	const out: RosterEntry[] = [];
	for (const p of parsed) {
		const name = p.name.trim();
		const base = normId(p.id) || slug(name) || "member";
		let id = base;
		let n = 2;
		while (used.has(id)) id = `${base}_${n++}`;
		used.add(id);
		out.push({ name, id, remoteDb: `mirror_${id}`, adjusted: id !== base, emptyName: !name });
	}
	return out;
}
