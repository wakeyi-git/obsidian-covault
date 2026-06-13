/** 메시지 본문을 텍스트/위키링크/URL/멘션/피드백 조각으로 분해(순수 함수, 렌더용). */

export type MessageSegment =
	| { kind: "text"; text: string }
	| { kind: "wikilink"; target: string; embed: boolean; raw: string }
	| { kind: "url"; url: string }
	| { kind: "mention"; name: string; raw: string }
	| { kind: "feedback"; path: string; uid: string; label: string; raw: string };

// 위키링크 [[..]] / 임베드 ![[..]] / http(s) URL / 멘션 @[이름] / 피드백 ((fb|경로|uid|라벨)).
const SEG_RE = /(!?\[\[[^\]]+\]\])|(https?:\/\/[^\s<>()]+)|(@\[[^\]]+\])|(\(\(fb\|[^)]*\)\))/g;

/** 본문을 클릭 가능한 조각 배열로 분해. 위키링크는 표시명/헤딩(#)을 제거한 target을 함께 준다. */
export function parseMessageBody(body: string): MessageSegment[] {
	const out: MessageSegment[] = [];
	let last = 0;
	for (const m of body.matchAll(SEG_RE)) {
		const idx = m.index ?? 0;
		if (idx > last) out.push({ kind: "text", text: body.slice(last, idx) });
		if (m[1]) {
			const raw = m[1];
			const embed = raw.startsWith("!");
			const inner = raw.replace(/^!?\[\[/, "").replace(/\]\]$/, "");
			const target = inner.split("|")[0].split("#")[0].trim();
			out.push({ kind: "wikilink", target, embed, raw });
		} else if (m[2]) {
			out.push({ kind: "url", url: m[2] });
		} else if (m[3]) {
			out.push({ kind: "mention", name: m[3].slice(2, -1), raw: m[3] }); // @[이름]
		} else if (m[4]) {
			// ((fb|경로|uid|라벨))
			const parts = m[4].slice(2, -2).split("|"); // ["fb", path, uid, label]
			out.push({ kind: "feedback", path: parts[1] ?? "", uid: parts[2] ?? "", label: parts.slice(3).join("|") || (parts[1] ?? ""), raw: m[4] });
		}
		last = idx + m[0].length;
	}
	if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
	return out;
}

// --- 대화 목록 상태 로직(평가 P2-6 — ChatSection에서 추출, 0.122.0 reload 경쟁/빈 화면 회귀 영역) ---

/**
 * 메시지 목록 변화 시그니처(채널·창 크기·길이·머리/꼬리 _id·꼬리 _rev). 직전과 같으면 재렌더를 생략해
 * 폴링 깜빡임을 막는다. 꼬리 _rev까지 포함해 같은 id의 내용 변경(편집·삭제 플래그)도 변화로 잡는다.
 */
export function messageListSig(
	channel: string,
	limit: number,
	msgs: ReadonlyArray<{ _id: string; _rev?: string }>,
): string {
	const last = msgs[msgs.length - 1];
	return `${channel}|${limit}|${msgs.length}|${msgs[0]?._id ?? ""}|${last?._id ?? ""}|${last?._rev ?? ""}`;
}

/**
 * 기존 렌더 id 목록이 새 목록의 prefix이면 append-only(꼬리만 추가). 머리가 바뀌거나(창 미끄러짐·삭제·
 * 이전 메시지 로드) 길이가 줄면 false → 전체 재구성. 길이가 같고 동일해도 false(추가할 것 없음).
 */
export function isAppendable(renderedIds: readonly string[], newIds: readonly string[]): boolean {
	return renderedIds.length > 0 && renderedIds.length < newIds.length && renderedIds.every((id, i) => newIds[i] === id);
}

/** 본문에서 링크/멘션 토큰을 걷어낸 짧은 미리보기(답글 인용·스니펫). max 초과 시 …로 자른다. */
export function messageSnippet(body: string, max = 60): string {
	const text = parseMessageBody(body)
		.map((s) => (s.kind === "text" ? s.text : s.kind === "url" ? s.url : s.kind === "wikilink" ? s.target : s.kind === "mention" ? `@${s.name}` : s.label))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
