/** ArrayBuffer → base64 (청크 처리로 대용량 스택오버플로 방지). */
export function abToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	const chunk = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
	}
	return btoa(binary);
}

export function describePouchError(e: any): string {
	if (!e) return "unknown error";
	const status = e.status ? `${e.status} ` : "";
	const name = e.name ? `${e.name}: ` : "";
	return `${status}${name}${e.message ?? e.reason ?? String(e)}`;
}
