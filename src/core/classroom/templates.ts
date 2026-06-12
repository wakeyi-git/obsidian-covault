/**
 * 학급 콘텐츠 템플릿(알림장·수업 안내·과제)과 프론트매터 ↔ NoticeDoc 매핑(순수 함수, 테스트 가능).
 *
 * 알림장·수업은 옵시디언 편집창에서 프론트매터로 작성한다. 새 글을 만들 때 템플릿(설정 경로 또는 내장
 * 기본)을 복사하고, 플러그인이 파일 프론트매터를 읽어 NoticeDoc(목록 메타)을 동기화한다. 과제 템플릿은
 * 배포 시 각 학생 작업 파일로 복사되는 본문(치환 변수 {{memberName}} 등)이다.
 */
import { t } from "../../i18n";

/** 내장 기본 알림장 템플릿. 프론트매터 `covault: notice` + 초안 플래그. */
export const DEFAULT_NOTICE_TEMPLATE = `---
covault: notice
title: "{{title}}"
published: false
pinned: false
responses: true
---

여기에 알림장 내용을 작성하세요.

작성을 마치면 위 속성의 \`published\`를 켜거나 대시보드의 **게시** 버튼을 눌러 구성원에게 공개합니다.
`;

/** 내장 기본 수업 안내 템플릿. 프론트매터 `covault: lesson` + 주(週)·요일·교시 키(day/period를 채우면 시간표 칸에 배치). */
export const DEFAULT_LESSON_TEMPLATE = `---
covault: lesson
title: "{{title}}"
published: false
week: "{{week}}"
day: ""
period: ""
---

## 학습 목표

-

## 수업 내용

1.

## 준비물 / 과제

-
`;

/** 내장 기본 과제 작업 파일 템플릿. 배포 시 {{memberName}}·{{date}} 등이 치환된다. */
export const DEFAULT_ASSIGNMENT_TEMPLATE = `# {{title}}

- 이름: {{memberName}}
- 날짜: {{date}}

---

여기에 과제를 작성하세요.
`;

export type NoticeTemplateKind = "notice" | "lesson" | "assignment";

/** 유형별 내장 기본 템플릿. */
export function defaultTemplate(kind: NoticeTemplateKind): string {
	if (kind === "lesson") return DEFAULT_LESSON_TEMPLATE;
	if (kind === "assignment") return DEFAULT_ASSIGNMENT_TEMPLATE;
	return DEFAULT_NOTICE_TEMPLATE;
}

/** 유형별 기본 템플릿 저장 경로(설정이 비었을 때 "기본 템플릿 만들기"가 쓰는 위치). 로케일 반영(평가 U-2). */
export function defaultTemplatePath(kind: NoticeTemplateKind): string {
	const name =
		kind === "lesson"
			? t("dashboard.template_name_lesson")
			: kind === "assignment"
				? t("dashboard.template_name_assignment")
				: t("dashboard.template_name_notice");
	return `${t("dashboard.template_folder")}/${name}.md`;
}

/** 템플릿 본문의 {{title}}·{{week}}·{{date}} 치환(알림장/수업 생성 시). */
export function applyNoticeVars(content: string, vars: { title?: string; week?: string; date?: string }): string {
	return content
		.replace(/\{\{\s*title\s*\}\}/g, vars.title ?? "")
		.replace(/\{\{\s*week\s*\}\}/g, vars.week ?? "")
		.replace(/\{\{\s*date\s*\}\}/g, vars.date ?? "");
}

/** 프론트매터에서 읽어 NoticeDoc에 반영할 필드. */
export interface NoticeFrontmatterFields {
	category: "notice" | "lesson";
	title: string;
	published: boolean;
	pinned: boolean;
	allowResponses: boolean;
	weekKey?: string;
}

/**
 * 파일 프론트매터가 CoVault 알림장/수업을 나타내면 NoticeDoc 필드로 매핑(아니면 null).
 * `covault: notice|lesson` 마커가 있어야 하며, fallbackTitle(파일명 등)으로 빈 제목을 보완한다.
 */
export function noticeFieldsFromFrontmatter(
	fm: Record<string, unknown> | undefined | null,
	fallbackTitle: string,
): NoticeFrontmatterFields | null {
	const marker = fm?.covault;
	if (marker !== "notice" && marker !== "lesson") return null;
	const rawTitle = typeof fm?.title === "string" ? fm.title.trim() : "";
	const week = typeof fm?.week === "string" ? fm.week.trim() : undefined;
	return {
		category: marker,
		title: rawTitle || fallbackTitle,
		published: fm?.published === true,
		pinned: fm?.pinned === true,
		allowResponses: fm?.responses !== false,
		weekKey: marker === "lesson" ? week || undefined : undefined,
	};
}
