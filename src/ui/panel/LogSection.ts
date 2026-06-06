import { Logger, LogEntry } from "../../core/log/Logger";
import { PanelSection } from "./PanelSection";
import { t } from "../../i18n";

/** 로그 탭 — 실시간 로그 + 지우기. (구 LogView 본문) */
export class LogSection implements PanelSection {
	private unsubscribe: (() => void) | null = null;
	private logEl: HTMLElement | null = null;

	constructor(private logger: Logger) {}

	render(container: HTMLElement): void {
		const toolbar = container.createDiv({ cls: "covault-log-toolbar" });
		const clearBtn = toolbar.createEl("button", { text: t("panel.clear") });
		clearBtn.onclick = () => this.logger.clear();

		this.logEl = container.createDiv({ cls: "covault-log-view" });
		for (const entry of this.logger.getEntries()) this.append(entry);

		this.unsubscribe = this.logger.subscribe((entry) => {
			if (entry.message === "__clear__") {
				this.logEl?.empty();
				return;
			}
			this.append(entry);
		});
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.logEl = null;
	}

	private append(entry: LogEntry): void {
		if (!this.logEl) return;
		const line = this.logEl.createDiv({ cls: `csl-line csl-${entry.level}` });
		line.createSpan({ cls: "csl-ts", text: new Date(entry.ts).toLocaleTimeString() });
		line.createSpan({ text: entry.message });
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}
}
