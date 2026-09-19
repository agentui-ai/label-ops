/**
 * ZPL — Zebra Programming Language.
 *
 * ZPL is raw text between `^XA` and `^XZ`, sent to the printer's TCP 9100
 * socket. The printer never answers. It does not validate, it does not report,
 * and it does not refuse: a field placed past the edge of the label is simply
 * not printed, and a `^` inside your data is read as the start of a command.
 *
 * So everything this module does is check the things the printer will not.
 */

/** Dots per millimetre by print density. `^FO` and `^A` are in DOTS, never mm. */
export const DPMM = { 203: 8, 300: 11.811023622047244, 600: 23.622047244094488 };

/**
 * Millimetres to dots, for the printer you are actually printing on.
 *
 * A layout worked out on a 203 dpi printer and sent to a 300 dpi one prints at
 * roughly 68% scale, bunched into the top-left corner — everything is "there",
 * nothing is where it belongs, and the ZPL is byte-identical. This is the most
 * expensive ZPL bug because the labels look almost right.
 */
export function mmToDots(mm, dpi = 203) {
    const d = DPMM[dpi];
    if (!d) throw new Error(`Unsupported print density ${dpi}. Known: ${Object.keys(DPMM).join(", ")} dpi.`);
    return Math.round(mm * d);
}

/**
 * Make data safe for `^FD`.
 *
 * `^` and `~` are ZPL's command prefixes. A product name containing one ends
 * the field and starts a command, so the label prints garbage or nothing — and
 * the data that does it is exactly the data nobody tests with: "AC^DC", "3~5mm",
 * a pasted Windows path, a customer's free-text note.
 *
 * `^FH` turns on hex escapes, after which `_XX` is a literal byte. Emit `^FH`
 * before `^FD` whenever you use this.
 */
export function escapeFieldData(value) {
    return String(value ?? "").replace(/[\^~_]/g, (c) => `_${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** Does this string need `^FH`? */
export function needsHexEscape(value) {
    return /[\^~_]/.test(String(value ?? ""));
}

/**
 * A label that knows its own size, in millimetres, and refuses to lie about it.
 *
 * Positions are given in mm and converted with the label's own dpi, so the same
 * layout code produces correct output on a 203 and a 300 dpi printer.
 */
export class ZplLabel {
    constructor({ dpi = 203, widthMm, heightMm, darkness, speed } = {}) {
        if (!(widthMm > 0) || !(heightMm > 0)) {
            throw new Error("A label needs widthMm and heightMm — bounds cannot be checked without them.");
        }
        this.dpi = dpi;
        this.widthMm = widthMm;
        this.heightMm = heightMm;
        this.darkness = darkness;
        this.speed = speed;
        this.fields = [];
    }

    get widthDots() { return mmToDots(this.widthMm, this.dpi); }
    get heightDots() { return mmToDots(this.heightMm, this.dpi); }

    /**
     * @param {object} f
     * @param {number} f.xMm @param {number} f.yMm
     * @param {string} f.text
     * @param {number} [f.fontHeightMm=3]
     * @param {number} [f.widthMm]   the box the text must fit in (enables the bounds check)
     */
    text({ xMm, yMm, text, fontHeightMm = 3, widthMm }) {
        this.fields.push({ kind: "text", xMm, yMm, text, fontHeightMm, widthMm });
        return this;
    }

    /**
     * @param {object} b
     * @param {"code128"|"ean13"|"code39"|"itf"|"qr"} b.type
     * @param {string} b.data
     * @param {boolean} [b.gs1]           Code 128 in GS1 mode (^BC …,,,,,A)
     * @param {boolean} [b.humanReadable=true]
     */
    barcode({ xMm, yMm, type, data, heightMm = 12, moduleDots = 2, humanReadable = true, gs1 = false }) {
        this.fields.push({ kind: "barcode", xMm, yMm, type, data, heightMm, moduleDots, humanReadable, gs1 });
        return this;
    }

    /**
     * Everything the printer would silently drop or misread.
     *
     * Run it before you open the socket. The printer will not tell you, the
     * operator will — three hundred labels later.
     */
    validate() {
        const issues = [];
        const W = this.widthDots;
        const H = this.heightDots;
        for (const [i, f] of this.fields.entries()) {
            const x = mmToDots(f.xMm, this.dpi);
            const y = mmToDots(f.yMm, this.dpi);
            const where = `field ${i} (${f.kind}${f.text ? ` "${String(f.text).slice(0, 20)}"` : ""})`;
            if (x < 0 || y < 0) {
                issues.push({ code: "NEGATIVE_ORIGIN", message: `${where} has a negative origin; the printer clamps it to 0 without saying so.` });
            }
            if (x >= W || y >= H) {
                issues.push({
                    code: "ORIGIN_OFF_LABEL",
                    message: `${where} starts at ${x},${y} dots but the label is ${W}x${H}. It will not print at all.`,
                    fix: `Keep origins inside ${W}x${H} dots (${this.widthMm}x${this.heightMm}mm at ${this.dpi} dpi).`,
                });
            }
            const boxW = f.widthMm !== undefined ? mmToDots(f.widthMm, this.dpi) : null;
            if (boxW !== null && x + boxW > W) {
                issues.push({
                    code: "FIELD_OVERFLOWS_LABEL",
                    message: `${where} spans to ${x + boxW} dots, past the label's ${W}. The right-hand part is clipped silently.`,
                });
            }
            const raw = f.kind === "barcode" ? f.data : f.text;
            if (needsHexEscape(raw)) {
                issues.push({
                    code: "UNESCAPED_CONTROL_CHAR",
                    message: `${where} contains ^, ~ or _, which ZPL reads as command prefixes.`,
                    fix: "This builder emits ^FH and escapes it for you; raw string concatenation would not.",
                    severity: "info",
                });
            }
            if (f.kind === "barcode" && f.type === "ean13" && !/^\d{12,13}$/.test(String(f.data))) {
                issues.push({ code: "EAN13_BAD_PAYLOAD", message: `${where}: EAN-13 needs 12 or 13 digits, got ${JSON.stringify(f.data)}.` });
            }
        }
        return issues;
    }

    build() {
        const L = ["^XA"];
        L.push(`^PW${this.widthDots}`);
        L.push(`^LL${this.heightDots}`);
        if (this.darkness !== undefined) L.push(`~SD${String(this.darkness).padStart(2, "0")}`);
        if (this.speed !== undefined) L.push(`^PR${this.speed}`);
        for (const f of this.fields) {
            const x = mmToDots(f.xMm, this.dpi);
            const y = mmToDots(f.yMm, this.dpi);
            if (f.kind === "text") {
                const h = mmToDots(f.fontHeightMm, this.dpi);
                L.push(`^FO${x},${y}`);
                L.push(`^A0N,${h},${h}`);
                if (f.widthMm !== undefined) L.push(`^FB${mmToDots(f.widthMm, this.dpi)},1,0,L,0`);
                L.push(`${needsHexEscape(f.text) ? "^FH" : ""}^FD${escapeFieldData(f.text)}^FS`);
            } else {
                const h = mmToDots(f.heightMm, this.dpi);
                L.push(`^FO${x},${y}`);
                L.push(`^BY${f.moduleDots}`);
                const hr = f.humanReadable ? "Y" : "N";
                switch (f.type) {
                    case "code128": L.push(`^BCN,${h},${hr},N,N${f.gs1 ? ",A" : ""}`); break;
                    case "ean13":   L.push(`^BEN,${h},${hr},N`); break;
                    case "code39":  L.push(`^B3N,N,${h},${hr},N`); break;
                    case "itf":     L.push(`^B2N,${h},${hr},N,N`); break;
                    case "qr":      L.push(`^BQN,2,6`); break;
                    default: throw new Error(`Unknown barcode type ${JSON.stringify(f.type)}`);
                }
                const data = f.type === "qr" ? `LA,${f.data}` : f.data;
                L.push(`${needsHexEscape(data) ? "^FH" : ""}^FD${escapeFieldData(data)}^FS`);
            }
        }
        L.push("^XZ");
        return L.join("\n");
    }
}

/**
 * Write raw ZPL to a printer's 9100 socket.
 *
 * The socket accepts the bytes and closes. **A successful write is not a
 * printed label** — it means the TCP connection worked. Out of paper, head
 * open, wrong label size: all of them accept your bytes silently. Treat the
 * printer as fire-and-forget and put the verification somewhere else (a scan
 * step, an operator confirmation).
 */
export async function sendToPrinter(zpl, { host, port = 9100, timeoutMs = 5000 } = {}) {
    const net = await import("node:net");
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, host, () => socket.write(zpl, () => socket.end()));
        socket.setTimeout(timeoutMs);
        socket.on("timeout", () => { socket.destroy(); reject(new Error(`Timeout connecting to ${host}:${port}`)); });
        socket.on("error", reject);
        socket.on("close", () => resolve({ host, port, bytes: Buffer.byteLength(zpl), delivered: true, printed: "unknown" }));
    });
}
