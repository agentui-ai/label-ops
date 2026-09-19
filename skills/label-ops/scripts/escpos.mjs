/**
 * ESC/POS — 58mm Bluetooth thermal receipt printers.
 *
 * A different protocol, a different transport and a different failure mode from
 * ZPL. These are byte commands over a BLE characteristic, and the two things
 * that go wrong are always the same: **text encoding** and **write size**.
 *
 * (For Zebra label printers see zpl.mjs. They share nothing but the word
 * "thermal".)
 */

export const ESC = 0x1b;
export const GS = 0x1d;

/** 58mm paper at 203 dpi: 384 dots, 32 characters in Font A, 42 in Font B. */
export const PAPER_58MM = { dots: 384, charsFontA: 32, charsFontB: 42 };

/**
 * Code pages these printers actually ship with, and the `ESC t n` selector.
 *
 * **A thermal printer does not speak UTF-8.** Send UTF-8 bytes and "café"
 * prints as "cafÃ©", "ñ" as "Ã±" — one character becomes two. The fix is two
 * steps that must agree: select a code page on the printer, and encode your
 * text to that same code page. Doing only the first is the common half-fix.
 */
export const CODEPAGES = {
    CP437: 0,  // US / default
    CP850: 2,  // Multilingual Latin-1 — safest for Western European accents
    CP860: 3,  // Portuguese
    CP863: 4,  // French Canadian
    CP865: 5,  // Nordic
    CP1252: 16, // Windows Latin-1
};

// The accented characters that matter in practice, in CP850 and CP437.
const CP850_MAP = {
    "Ç":128,"ü":129,"é":130,"â":131,"ä":132,"à":133,"å":134,"ç":135,"ê":136,"ë":137,
    "è":138,"ï":139,"î":140,"ì":141,"Ä":142,"Å":143,"É":144,"æ":145,"Æ":146,"ô":147,
    "ö":148,"ò":149,"û":150,"ù":151,"ÿ":152,"Ö":153,"Ü":154,"ø":155,"£":156,"Ø":157,
    "×":158,"ƒ":159,"á":160,"í":161,"ó":162,"ú":163,"ñ":164,"Ñ":165,"ª":166,"º":167,
    "¿":168,"®":169,"¬":170,"½":171,"¼":172,"¡":173,"«":174,"»":175,"Á":181,"Â":182,
    "À":183,"©":184,"¢":189,"¥":190,"ã":198,"Ã":199,"ð":208,"Ð":209,"Ê":210,"Ë":211,
    "È":212,"ı":213,"Í":214,"Î":215,"Ï":216,"Ì":222,"Ó":224,"ß":225,"Ô":226,"Ò":227,
    "õ":228,"Õ":229,"µ":230,"þ":231,"Þ":232,"Ú":233,"Û":234,"Ù":235,"ý":236,"Ý":237,
    "°":248,"·":250,"¹":251,"³":252,"²":253,
};

/**
 * Encode text to a printer code page.
 *
 * Unmappable characters become `?` rather than a random byte — a visible gap
 * beats a wrong glyph, and it tells you the code page is wrong for this market.
 */
export function encodeText(text, codepage = "CP850") {
    const map = codepage === "CP437" || codepage === "CP850" ? CP850_MAP : null;
    const out = [];
    for (const ch of String(text)) {
        const code = ch.codePointAt(0);
        if (code < 128) out.push(code);
        else if (map && map[ch] !== undefined) out.push(map[ch]);
        else out.push(0x3f); // '?'
    }
    return Uint8Array.from(out);
}

/** Which characters this code page cannot render — check before you print. */
export function unmappable(text, codepage = "CP850") {
    const bad = new Set();
    const map = CP850_MAP;
    for (const ch of String(text)) {
        const code = ch.codePointAt(0);
        if (code >= 128 && map[ch] === undefined) bad.add(ch);
    }
    return [...bad];
}

/** Fluent ESC/POS byte builder. */
export class Receipt {
    constructor({ codepage = "CP850", width = PAPER_58MM.charsFontA } = {}) {
        this.codepage = codepage;
        this.width = width;
        this.bytes = [];
        this.raw(ESC, 0x40); // ESC @ — initialise
        this.raw(ESC, 0x74, CODEPAGES[codepage] ?? 0); // ESC t n — select code page
    }

    raw(...b) { this.bytes.push(...b); return this; }

    text(s) { this.bytes.push(...encodeText(s, this.codepage)); return this; }

    line(s = "") { return this.text(s).raw(0x0a); }

    /** Left / centre / right, ESC a n. */
    align(mode) { return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[mode] ?? 0); }

    bold(on = true) { return this.raw(ESC, 0x45, on ? 1 : 0); }

    /** GS ! n — width and height multipliers, 1-8 each. */
    size(w = 1, h = 1) {
        const clamp = (v) => Math.max(1, Math.min(8, v)) - 1;
        return this.raw(GS, 0x21, (clamp(w) << 4) | clamp(h));
    }

    /** "Item.........1.50" — the layout every receipt needs and no command provides. */
    columns(left, right) {
        const l = String(left);
        const r = String(right);
        const gap = Math.max(1, this.width - l.length - r.length);
        return this.line(l + " ".repeat(gap) + r);
    }

    feed(n = 3) { return this.raw(ESC, 0x64, n); }

    cut(partial = true) { return this.raw(GS, 0x56, partial ? 1 : 0); }

    build() { return Uint8Array.from(this.bytes); }
}

/**
 * Write to a BLE characteristic in chunks, with a pause between them.
 *
 * Web Bluetooth's default MTU leaves about 20 usable bytes per write, and these
 * printers have a small input buffer with no flow control. A single big write
 * either throws, or — worse — succeeds and prints half a receipt. Chunk it, and
 * give the printer a moment between chunks.
 */
export async function writeChunked(characteristic, bytes, { chunkSize = 20, delayMs = 20 } = {}) {
    for (let i = 0; i < bytes.length; i += chunkSize) {
        await characteristic.writeValue(bytes.slice(i, i + chunkSize));
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    return { chunks: Math.ceil(bytes.length / chunkSize), bytes: bytes.length };
}
