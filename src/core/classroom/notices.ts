import { NoticeDoc, ResponseDoc } from "../model/types";

/** 제목 → 파일명 슬러그(경로 불법문자 제거, 한글 허용, 길이 제한). */
export function slugify(title: string): string {
	const s = title
		.trim()
		.replace(/[\\/:*?"<>|#^[\]]+/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return s.slice(0, 40) || "notice";
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** 알림장 본문 파일 경로: <folder>/알림장/<YYYYMMDD-HHmm>-<slug>.md. */
export function noticeFilePath(folder: string, ts: number, title: string): string {
	const d = new Date(ts);
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
	return `${folder}/알림장/${stamp}-${slugify(title)}.md`;
}

/** 표시 순서: 삭제 제외 → 고정(pinned) 먼저 → 최신(postedAtMs desc). */
export function sortNotices(notices: NoticeDoc[]): NoticeDoc[] {
	return notices
		.filter((n) => !n.deleted)
		.sort((a, b) => {
			const pin = Number(!!b.pinned) - Number(!!a.pinned);
			return pin !== 0 ? pin : b.postedAtMs - a.postedAtMs;
		});
}

export interface ResponseSummary {
	readUsers: string[];
	readCount: number;
	unread: string[]; // 아직 안 읽은 memberId
	comments: ResponseDoc[]; // comment/question(작성순)
}

/** 한 알림장의 응답 집계(읽음 명단 + 미읽음 + 댓글/질문 스레드). */
export function summarizeResponses(responses: ResponseDoc[], memberIds: string[]): ResponseSummary {
	const live = responses.filter((r) => !r.deleted);
	const readUsers = [...new Set(live.filter((r) => r.kind === "read").map((r) => r.byUser))];
	const readSet = new Set(readUsers);
	const unread = memberIds.filter((m) => !readSet.has(m));
	const comments = live
		.filter((r) => r.kind === "comment" || r.kind === "question")
		.sort((a, b) => a.createdAtMs - b.createdAtMs);
	return { readUsers, readCount: readUsers.length, unread, comments };
}
