import { App, TFile, TFolder, normalizePath } from "obsidian";
import { CoVaultSettings, MemberConfig } from "../../settings/types";
import { ExistingPolicy, CopyAction, decideAction } from "./copyAction";

export { decideAction };
export type { ExistingPolicy, CopyAction };

/** 로컬 시간대 기준 YYYY-MM-DD. */
function localDate(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface CopyOptions {
	/** 단일 파일 복사 시 학생 폴더 내 대상 상대 경로. */
	destPath: string;
	policy: ExistingPolicy;
	substitute: boolean;
}

/** 학생 1명의 복사 결과(성공/건너뜀 수 + 오류). */
export interface CopyDetail {
	memberId: string;
	memberName: string;
	written: number;
	skipped: number;
	error?: string;
}

export interface CopyResult {
	written: number;
	skipped: number;
	details: CopyDetail[];
}

/** 미리보기(dry-run) — 학생별 최종 대상 경로·동작 예상 + 치환 샘플. */
export interface PlanEntry {
	destPath: string;
	action: CopyAction;
}
export interface MemberPlan {
	memberId: string;
	memberName: string;
	entries: PlanEntry[];
}
export interface CopyPlan {
	members: MemberPlan[];
	sampleBefore?: string;
	sampleAfter?: string;
}

/**
 * 교사 → 학생 파일/폴더 복사. 기술문서 §12.5 / §20.
 *
 * 학생 폴더(member.localRoot)에 파일을 쓰면 기존 동기화 엔진이 자동으로 각 학생 vault에 전파한다.
 * 템플릿 변수 치환(§20.4)과 기존 파일 처리 정책(§20.3)을 지원한다.
 */
export class BulkCopy {
	constructor(
		private app: App,
		private settings: CoVaultSettings,
	) {}

	/** 단일 파일을 선택 학생들에게 복사. */
	async copyFile(file: TFile, members: MemberConfig[], opts: CopyOptions): Promise<CopyResult> {
		const content = await this.app.vault.read(file);
		return this.run(members, [{ rel: opts.destPath, content }], opts);
	}

	/** 폴더 아래 markdown 전체를 선택 학생들에게 복사(폴더 내부 구조 유지, 폴더명은 제외). */
	async copyFolder(folder: TFolder, members: MemberConfig[], opts: CopyOptions): Promise<CopyResult> {
		const files = this.markdownIn(folder);
		const items: Array<{ rel: string; content: string }> = [];
		for (const f of files) items.push({ rel: f.path.slice(folder.path.length + 1), content: await this.app.vault.read(f) });
		return this.run(members, items, opts);
	}

	/** dry-run: 아무것도 쓰지 않고 학생별 대상 경로·동작 예상 + 치환 샘플을 만든다. */
	async preview(src: TFile | TFolder, members: MemberConfig[], opts: CopyOptions): Promise<CopyPlan> {
		const rels = src instanceof TFolder ? this.markdownIn(src).map((f) => f.path.slice(src.path.length + 1)) : [opts.destPath];
		const plan: CopyPlan = { members: [] };
		for (const st of members) {
			const entries: PlanEntry[] = rels.map((rel) => {
				let destPath = normalizePath(`${st.localRoot}/${rel}`);
				const existing = this.app.vault.getAbstractFileByPath(destPath) instanceof TFile;
				const action = decideAction(existing, opts.policy);
				if (action === "rename") destPath = this.availableName(destPath);
				return { destPath, action };
			});
			plan.members.push({ memberId: st.memberId, memberName: st.memberName, entries });
		}
		// 치환 샘플: 첫 파일 + 첫 학생
		if (opts.substitute && members[0]) {
			const first = src instanceof TFolder ? this.markdownIn(src)[0] : src;
			if (first) {
				const content = await this.app.vault.read(first);
				plan.sampleBefore = content.slice(0, 200);
				plan.sampleAfter = this.substitute(content, members[0]).slice(0, 200);
			}
		}
		return plan;
	}

	// --- 내부 ---

	private async run(
		members: MemberConfig[],
		items: Array<{ rel: string; content: string }>,
		opts: CopyOptions,
	): Promise<CopyResult> {
		const res: CopyResult = { written: 0, skipped: 0, details: [] };
		for (const st of members) {
			const d: CopyDetail = { memberId: st.memberId, memberName: st.memberName, written: 0, skipped: 0 };
			try {
				for (const it of items) {
					const r = await this.writeForMember(st, it.rel, it.content, opts);
					if (r === "written") d.written++;
					else d.skipped++;
				}
			} catch (e) {
				d.error = e instanceof Error ? e.message : String(e);
			}
			res.written += d.written;
			res.skipped += d.skipped;
			res.details.push(d);
		}
		return res;
	}

	private async writeForMember(
		st: MemberConfig,
		destRel: string,
		content: string,
		opts: CopyOptions,
	): Promise<"written" | "skipped"> {
		const body = opts.substitute ? this.substitute(content, st) : content;
		let localPath = normalizePath(`${st.localRoot}/${destRel}`);

		const existing = this.app.vault.getAbstractFileByPath(localPath);
		if (existing instanceof TFile) {
			if (opts.policy === "skip") return "skipped";
			if (opts.policy === "overwrite") {
				await this.app.vault.process(existing, () => body); // 백그라운드 쓰기: 가이드라인 권장
				return "written";
			}
			// rename: 빈 이름 찾기
			localPath = this.availableName(localPath);
		}

		await this.ensureParent(localPath);
		await this.app.vault.create(localPath, body);
		return "written";
	}

	/** 템플릿 변수 치환. 기술문서 §20.4. */
	private substitute(content: string, st: MemberConfig): string {
		const s = this.settings;
		const date = localDate(); // 로컬 시간대 기준 (UTC면 하루 어긋남)
		return content
			.replace(/\{\{\s*memberId\s*\}\}/g, st.memberId)
			.replace(/\{\{\s*memberName\s*\}\}/g, st.memberName || st.memberId)
			.replace(/\{\{\s*workspaceId\s*\}\}/g, s.workspaceId)
			.replace(/\{\{\s*date\s*\}\}/g, date)
			.replace(/\{\{\s*group\s*\}\}/g, "");
	}

	private markdownIn(folder: TFolder): TFile[] {
		const out: TFile[] = [];
		const walk = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFolder) walk(child);
				else if (child instanceof TFile && child.extension === "md") out.push(child);
			}
		};
		walk(folder);
		return out;
	}

	private availableName(localPath: string): string {
		const dot = localPath.lastIndexOf(".");
		const base = dot > 0 ? localPath.slice(0, dot) : localPath;
		const ext = dot > 0 ? localPath.slice(dot) : "";
		for (let i = 1; i < 1000; i++) {
			const candidate = `${base} ${i}${ext}`;
			if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
		}
		return `${base} ${Date.now()}${ext}`;
	}

	private async ensureParent(localPath: string): Promise<void> {
		const idx = localPath.lastIndexOf("/");
		if (idx <= 0) return;
		const folder = localPath.slice(0, idx);
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => {
				/* 이미 존재 등 무시 */
			});
		}
	}
}
