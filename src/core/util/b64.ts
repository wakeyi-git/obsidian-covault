/**
 * UTF-8 안전 base64 인코딩/디코딩. deprecated `escape`/`unescape` 우회(btoa(unescape(encodeURIComponent)))를
 * TextEncoder/TextDecoder 기반으로 대체한다. 큰 입력도 안전하게 청크 없이 루프 처리.
 */

export function utf8ToB64(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

export function b64ToUtf8(b64: string): string {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}
