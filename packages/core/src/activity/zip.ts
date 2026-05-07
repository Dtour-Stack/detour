export type ZipEntry = {
	name: string;
	data: string | Uint8Array;
};

type PreparedZipEntry = {
	name: Uint8Array;
	data: Uint8Array;
	crc: number;
	localOffset: number;
};

const encoder = new TextEncoder();
const CRC_TABLE = new Uint32Array(256);

for (let i = 0; i < 256; i += 1) {
	let c = i;
	for (let j = 0; j < 8; j += 1) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	CRC_TABLE[i] = c >>> 0;
}

function bytes(value: string | Uint8Array): Uint8Array {
	return typeof value === "string" ? encoder.encode(value) : value;
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
	const year = Math.max(1980, date.getFullYear());
	return {
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
		time:
			(date.getHours() << 11) |
			(date.getMinutes() << 5) |
			Math.floor(date.getSeconds() / 2),
	};
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function localHeader(
	entry: PreparedZipEntry,
	stamp: { date: number; time: number },
): Uint8Array {
	const header = new Uint8Array(30);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x04034b50, true);
	view.setUint16(4, 20, true);
	view.setUint16(10, stamp.time, true);
	view.setUint16(12, stamp.date, true);
	view.setUint32(14, entry.crc, true);
	view.setUint32(18, entry.data.length, true);
	view.setUint32(22, entry.data.length, true);
	view.setUint16(26, entry.name.length, true);
	return header;
}

function centralHeader(
	entry: PreparedZipEntry,
	stamp: { date: number; time: number },
): Uint8Array {
	const header = new Uint8Array(46);
	const view = new DataView(header.buffer);
	view.setUint32(0, 0x02014b50, true);
	view.setUint16(4, 20, true);
	view.setUint16(6, 20, true);
	view.setUint16(12, stamp.time, true);
	view.setUint16(14, stamp.date, true);
	view.setUint32(16, entry.crc, true);
	view.setUint32(20, entry.data.length, true);
	view.setUint32(24, entry.data.length, true);
	view.setUint16(28, entry.name.length, true);
	view.setUint32(42, entry.localOffset, true);
	return header;
}

function endRecord(
	entryCount: number,
	centralSize: number,
	centralOffset: number,
): Uint8Array {
	const record = new Uint8Array(22);
	const view = new DataView(record.buffer);
	view.setUint32(0, 0x06054b50, true);
	view.setUint16(8, entryCount, true);
	view.setUint16(10, entryCount, true);
	view.setUint32(12, centralSize, true);
	view.setUint32(16, centralOffset, true);
	return record;
}

export function buildZip(
	entries: readonly ZipEntry[],
	now = new Date(),
): Uint8Array {
	const stamp = dosDateTime(now);
	const prepared: PreparedZipEntry[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name.replace(/^\/+/, ""));
		const data = bytes(entry.data);
		prepared.push({
			name,
			data,
			crc: crc32(data),
			localOffset: offset,
		});
		offset += 30 + name.length + data.length;
	}

	const parts: Uint8Array[] = [];
	let total = 0;
	for (const entry of prepared) {
		for (const part of [localHeader(entry, stamp), entry.name, entry.data]) {
			parts.push(part);
			total += part.length;
		}
	}
	const centralOffset = total;
	for (const entry of prepared) {
		for (const part of [centralHeader(entry, stamp), entry.name]) {
			parts.push(part);
			total += part.length;
		}
	}
	const centralSize = total - centralOffset;
	const end = endRecord(prepared.length, centralSize, centralOffset);
	parts.push(end);
	total += end.length;
	return concat(parts, total);
}
