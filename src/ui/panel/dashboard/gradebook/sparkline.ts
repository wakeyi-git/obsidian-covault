/** 외부 라이브러리 없는 SVG 스파크라인. null 구간은 선을 끊는다. */
export function renderSparkline(parent: HTMLElement, values: Array<number | null>, title?: string): void {
	const W = 72;
	const H = 20;
	const PAD = 2;
	const svg = parent.createSvg("svg", { cls: "covault-dash-spark", attr: { viewBox: `0 0 ${W} ${H}`, width: W, height: H } });
	if (title) svg.setAttr("aria-label", title);

	const n = values.length;
	if (n === 0 || values.every((v) => v == null)) return;
	const x = (i: number): number => (n === 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (n - 1));
	const y = (v: number): number => H - PAD - (Math.max(0, Math.min(100, v)) * (H - PAD * 2)) / 100;

	// null로 끊긴 구간별 polyline
	let seg: string[] = [];
	const flush = (): void => {
		if (seg.length >= 2) svg.createSvg("polyline", { attr: { points: seg.join(" ") } });
		seg = [];
	};
	values.forEach((v, i) => {
		if (v == null) flush();
		else seg.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
	});
	flush();

	// 마지막 유효 점 강조
	for (let i = n - 1; i >= 0; i--) {
		const v = values[i];
		if (v != null) {
			svg.createSvg("circle", { attr: { cx: x(i).toFixed(1), cy: y(v).toFixed(1), r: 1.8 } });
			break;
		}
	}
}
