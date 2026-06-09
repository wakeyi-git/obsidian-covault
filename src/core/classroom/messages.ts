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
