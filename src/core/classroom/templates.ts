/**
 * 학급 콘텐츠 템플릿(알림장·수업 안내·과제)과 프론트매터 ↔ NoticeDoc 매핑(순수 함수, 테스트 가능).
 *
 * 알림장·수업은 옵시디언 편집창에서 프론트매터로 작성한다. 새 글을 만들 때 템플릿(설정 경로 또는 내장
 * 기본)을 복사하고, 플러그인이 파일 프론트매터를 읽어 NoticeDoc(목록 메타)을 동기화한다. 과제 템플릿은
 * 배포 시 각 학생 작업 파일로 복사되는 본문(치환 변수 {{memberName}} 등)이다.
 */
import { t } from "../../i18n";

export type NoticeTemplateKind = "notice" | "lesson" | "assignment";

/**
 * 유형별 내장 기본 템플릿(평가 P1-1 — 본문 현지화). 프론트매터(`covault: notice|lesson` 등)는 파서가
 * 인식하는 구조라 언어 중립으로 코드에 고정하고, 산문(설명·섹션 제목·라벨)만 i18n으로 분리한다 →
 * 영어 로케일 구성원에게 한국어 본문 파일이 배포되던 문제 해소. {{title}}/{{memberName}}/{{date}}/{{week}}
 * 치환 변수는 그대로 유지(배포 시 substituteTemplate/applyNoticeVars가 채운다).
 */
export function defaultTemplate(kind: NoticeTemplateKind): string {
	if (kind === "lesson") {
		return `---
covault: lesson
title: "{{title}}"
published: false
week: "{{week}}"
day: ""
period: ""
---

## ${t("dashboard.tpl_lesson_objective")}

-

## ${t("dashboard.tpl_lesson_content")}

1.

## ${t("dashboard.tpl_lesson_materials")}

-
`;
	}
	if (kind === "assignment") {
		return `# {{title}}

- ${t("dashboard.tpl_assignment_name")}: {{memberName}}
- ${t("dashboard.tpl_assignment_date")}: {{date}}

---

${t("dashboard.tpl_assignment_body")}
`;
	}
	return `---
covault: notice
title: "{{title}}"
published: false
pinned: false
responses: true
---

${t("dashboard.tpl_notice_body")}

${t("dashboard.tpl_notice_publish_hint")}
`;
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
