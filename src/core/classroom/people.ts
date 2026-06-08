/** 사용자 식별자(userId/memberId) → 표시 이름 해석(순수 함수). */

export interface NameResolveOpts {
	/** 보는 사람 본인 userId. */
	ownUserId: string;
	/** 본인 표시 이름. */
	ownName: string;
	/** 운영자가 아는 구성원 명단(memberId → memberName). */
	members: Array<{ memberId: string; memberName: string }>;
	/** 구성원이 교사를 가리킬 때 쓸 라벨(예: "선생님"). */
	teacherLabel: string;
}

/**
 * 작성자(byUser) + 역할(byRole)을 표시 이름으로 바꾼다.
 * - 본인 → 본인 이름
 * - 명단에 있는 구성원 → 구성원 이름(운영자 시점)
 * - 그 외 운영자 작성 → 교사 라벨(구성원 시점)
 * - 알 수 없으면 식별자 그대로
 */
export function resolveSenderName(byUser: string, byRole: "member" | "manager", opts: NameResolveOpts): string {
	if (byUser && byUser === opts.ownUserId) return opts.ownName || byUser;
	const m = opts.members.find((x) => x.memberId === byUser);
	if (m) return m.memberName || m.memberId;
	if (byRole === "manager") return opts.teacherLabel;
	return byUser;
}

/** 구성원 id 목록 → 이름 목록(명단에 있으면 이름, 없으면 id). */
export function resolveMemberNames(ids: string[], members: Array<{ memberId: string; memberName: string }>): string[] {
	return ids.map((id) => {
		const m = members.find((x) => x.memberId === id);
		return m ? m.memberName || m.memberId : id;
	});
}
