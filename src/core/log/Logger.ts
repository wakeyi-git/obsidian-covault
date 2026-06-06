import { Notice } from "obsidian";

export type LogLevel = "info" | "ok" | "warn" | "error";

export interface LogEntry {
	ts: number;
	level: LogLevel;
	message: string;
}

type Listener = (entry: LogEntry) => void;

/**
 * 로그 패널용 단순 로거.
 * 콘솔 + 인메모리 버퍼 + 리스너(LogView)로 전달하고, 중요한 항목은 Notice로도 띄운다.
 */
export class Logger {
	private buffer: LogEntry[] = [];
	private listeners = new Set<Listener>();
	private readonly maxEntries = 500;

	log(level: LogLevel, message: string, notice = false): void {
		const entry: LogEntry = { ts: Date.now(), level, message };
		this.buffer.push(entry);
		if (this.buffer.length > this.maxEntries) {
			this.buffer.shift();
		}

		// 콘솔에는 오류/경고만 출력(정보 로그는 인앱 로그 뷰에만 — 콘솔 스팸 방지).
		const tag = `[covault]`;
		if (level === "error") console.error(tag, message);
		else if (level === "warn") console.warn(tag, message);

		if (notice) new Notice(`CoVault: ${message}`);

		for (const listener of this.listeners) listener(entry);
	}

	info(message: string, notice = false): void {
		this.log("info", message, notice);
	}
	ok(message: string, notice = false): void {
		this.log("ok", message, notice);
	}
	warn(message: string, notice = false): void {
		this.log("warn", message, notice);
	}
	error(message: string, notice = false): void {
		this.log("error", message, notice);
	}

	getEntries(): readonly LogEntry[] {
		return this.buffer;
	}

	clear(): void {
		this.buffer = [];
		for (const listener of this.listeners) listener({ ts: Date.now(), level: "info", message: "__clear__" });
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
