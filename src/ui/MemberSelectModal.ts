import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

/**
 * 구성원 다중 선택 모달(평가 P2-2 — 설정 탭 정보구조 재편). 공유 공간 카드의 구성원×공간 O(M×N) 토글
 * 그리드를 대체한다 — 카드마다 버튼 하나로 열고, 스크롤 가능한 체크박스 목록 + 전체/해제로 고른다.
 * GroupEditModal의 체크박스 그리드(covault-rt-parts) 패턴 재사용.
 */
export class MemberSelectModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private members: Array<{ memberId: string; memberName: string }>,
		private initial: string[],
		private onSave: (memberIds: string[]) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const c = this.contentEl;
		c.createEl("h3", { text: this.title });
		const selected = new Set(this.initial);

		const head = new Setting(c);
		const grid = c.createDiv({ cls: "covault-rt-parts" });
		const labels = new Map<string, HTMLElement>();
		const cbs = new Map<string, HTMLInputElement>();
		const setOne = (memberId: string, on: boolean): void => {
			if (on) selected.add(memberId);
			else selected.delete(memberId);
			const cb = cbs.get(memberId);
			if (cb) cb.checked = on;
			labels.get(memberId)?.toggleClass("is-on", on);
		};
		for (const m of this.members) {
			const lab = grid.createEl("label", { cls: "covault-rt-part" });
			const cb = lab.createEl("input", { attr: { type: "checkbox" } });
			cb.checked = selected.has(m.memberId);
			cb.onchange = () => setOne(m.memberId, cb.checked);
			lab.toggleClass("is-on", cb.checked);
			lab.createSpan({ text: m.memberName || m.memberId });
			labels.set(m.memberId, lab);
			cbs.set(m.memberId, cb);
		}
		head.addButton((b) => b.setButtonText(t("deploy.select_all")).onClick(() => this.members.forEach((m) => setOne(m.memberId, true))));
		head.addButton((b) => b.setButtonText(t("deploy.none")).onClick(() => this.members.forEach((m) => setOne(m.memberId, false))));

		new Setting(c).addButton((b) =>
			b
				.setButtonText(t("common.save"))
				.setCta()
				.onClick(() => {
					// 입력 순서가 아닌 명단 순서로 정렬해 결정적 결과(배포 지문·비교 안정).
					this.onSave(this.members.map((m) => m.memberId).filter((id) => selected.has(id)));
					this.close();
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
