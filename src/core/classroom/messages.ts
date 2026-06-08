/** 메시지 본문을 텍스트/위키링크/URL 조각으로 분해(순수 함수, 렌더용). */

export type MessageSegment =
	| { kind: "text"; text: string }
	| { kind: "wikilink"; target: string; embed: boolean; raw: string }
	| { kind: "url"; url: string };

// 위키링크 [[..]] 또는 임베드 ![[..]] 또는 http(s) URL.
const SEG_RE = /(!?\[\[[^\]]+\]\])|(https?:\/\/[^\s<>()]+)/g;

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
		}
		last = idx + m[0].length;
	}
	if (last < body.length) out.push({ kind: "text", text: body.slice(last) });
	return out;
}
