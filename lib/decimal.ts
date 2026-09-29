// Exact decimal addition for quantities. Long identifiers never enter arithmetic.
function parts(value: string): { integer: bigint; scale: number } {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error("数量不是有效十进制数");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  return { integer: BigInt(whole + fraction) * (negative ? -1n : 1n), scale: fraction.length };
}

function format(integer: bigint, scale: number): string {
  const negative = integer < 0n;
  const absolute = (negative ? -integer : integer).toString().padStart(scale + 1, "0");
  const raw = scale ? `${absolute.slice(0, -scale)}.${absolute.slice(-scale)}` : absolute;
  const trimmed = raw.includes(".") ? raw.replace(/0+$/, "").replace(/\.$/, "") : raw;
  return (negative && integer !== 0n ? "-" : "") + trimmed;
}

export function normalizeQuantity(value: unknown): string {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("缺少可订购量");
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    throw new Error("数量超出可核验精度");
  }
  let raw = String(value).trim();
  if (/e/i.test(raw)) {
    const match = raw.match(/^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
    if (!match || Math.abs(Number(match[4])) > 100) throw new Error("数量格式异常");
    const digits = match[2] + (match[3] || "");
    const point = match[2].length + Number(match[4]);
    raw = match[1] + (point <= 0 ? "0." + "0".repeat(-point) + digits : point >= digits.length ? digits + "0".repeat(point - digits.length) : digits.slice(0, point) + "." + digits.slice(point));
  }
  const parsed = parts(raw);
  return format(parsed.integer, parsed.scale);
}

export function addQuantity(left: string, right: string): string {
  const a = parts(left), b = parts(right);
  const scale = Math.max(a.scale, b.scale);
  return format(a.integer * 10n ** BigInt(scale - a.scale) + b.integer * 10n ** BigInt(scale - b.scale), scale);
}

export function compareQuantity(left: string, right: string): number {
  const difference = parts(addQuantity(left, right.startsWith("-") ? right.slice(1) : "-" + right)).integer;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function subtractQuantity(left: string, right: string): string {
  return addQuantity(left, right.startsWith("-") ? right.slice(1) : "-" + right);
}
