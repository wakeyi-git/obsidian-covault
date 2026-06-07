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

/** 게시 본문 파일 경로: <folder>/<sub>/<YYYYMMDD-HHmm>-<slug>.md. sub=알림장(기본)/수업. */
export function noticeFilePath(folder: string, ts: number, title: string, sub = "알림장"): string {
	const d = new Date(ts);
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
	return `${folder}/${sub}/${stamp}-${slugify(title)}.md`;
}

/**
 * 같은 파일 경로를 가리키지만 uid가 다른 옛 게시 메타(직접 uid 변경 등으로 생긴 중복/고아) 목록(순수).
 * 한 파일 = 하나의 게시여야 하므로, keepUid가 아닌 나머지는 폐기 대상이다.
 */
export function staleNoticesForPath(notices: NoticeDoc[], path: string, keepUid: string): NoticeDoc[] {
	return notices.filter((n) => !n.deleted && n.filePath === path && n.uid !== keepUid);
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

/** 수업이 연결된 시간표 칸 위치(요일 인덱스, 교시 인덱스). */
export interface LessonSlot {
	day: number;
	period: number;
}

/**
 * 수업 안내를 시간표 슬롯 기준으로 정렬(순수). 오늘 요일을 맨 앞에 두고(요일 회전), 같은 요일은 교시 순서.
 * 시간표에 연결되지 않은 수업은 뒤로(최신순). todayDayIndex/ numDays는 월=0 기준.
 */
export function sortLessonsBySchedule<T extends { uid: string; postedAtMs: number }>(
	lessons: T[],
	slotByUid: Map<string, LessonSlot>,
	todayDayIndex: number,
	numDays: number,
): T[] {
	const rotated = (day: number) => (((day - todayDayIndex) % numDays) + numDays) % numDays;
	return [...lessons].sort((a, b) => {
		const sa = slotByUid.get(a.uid);
		const sb = slotByUid.get(b.uid);
		if (sa && sb) {
			const ra = rotated(sa.day);
			const rb = rotated(sb.day);
			if (ra !== rb) return ra - rb;
			if (sa.period !== sb.period) return sa.period - sb.period;
			return a.postedAtMs - b.postedAtMs;
		}
		if (sa) return -1; // 슬롯 연결된 수업이 먼저
		if (sb) return 1;
		return b.postedAtMs - a.postedAtMs; // 둘 다 미연결: 최신순
	});
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
