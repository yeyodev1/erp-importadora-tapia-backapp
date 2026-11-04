import { CustomError } from "../errors/customError.error";

/**
 * Lee el estado de cuenta en CSV tal como lo baja la banca virtual de cada
 * banco: separador , ; o tabulador, fechas dd/mm/aaaa o aaaa-mm-dd y montos
 * con coma o punto decimal. Funciones puras: no tocan la base.
 */
export interface StatementLine {
  /** Número de fila en el archivo (1 = primera). */
  line: number;
  date: Date;
  description: string;
  reference: string;
  /** Centavos, positivo. */
  amount: number;
  direction: "in" | "out";
}

export type ColumnKey = "date" | "description" | "reference" | "debit" | "credit" | "amount";
export type ColumnMapping = Partial<Record<ColumnKey, string | number>>;

// El orden importa: "fecha" se toma primero para que "Fecha valor" no pase por monto.
const ALIASES: [ColumnKey, string[]][] = [
  ["date", ["fecha", "date"]],
  ["debit", ["debito", "cargo", "retiro", "egreso"]],
  ["credit", ["credito", "abono", "deposito", "ingreso"]],
  ["reference", ["referencia", "documento", "numero", "cheque", "comprobante", "no."]],
  ["description", ["descripcion", "concepto", "detalle", "transaccion", "movimiento"]],
  ["amount", ["valor", "monto", "importe"]],
];

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Divide una fila respetando comillas ("1,234.50" no se parte). */
export function splitRow(row: string, sep: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (quoted && row[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

export function detectSeparator(rows: string[]): string {
  const sample = rows.slice(0, 20).join("\n").replace(/"[^"]*"/g, "");
  const counts = [";", "\t", ","].map((sep) => ({ sep, n: sample.split(sep).length - 1 }));
  return counts.sort((a, b) => b.n - a.n)[0].sep;
}

/** "31/10/2026", "31-10-2026" o "2026-10-31" → Date al mediodía UTC. */
export function parseStatementDate(raw: string): Date | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let [y, mo, d] = m ? [m[1], m[2], m[3]] : ["", "", ""];
  if (!m) {
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
    if (!m) return null;
    [d, mo, y] = [m[1], m[2], m[3]];
  }
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 12));
  return date.getUTCDate() === Number(d) && date.getUTCMonth() === Number(mo) - 1 ? date : null;
}

/**
 * "1.234,56", "1,234.56", "150.25", "(80,00)", "-12" → centavos con signo.
 * Un solo separador seguido de exactamente 3 dígitos es de miles.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/\s|\$|usd/gi, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith("-") || s.endsWith("-")) { neg = !neg; s = s.replace(/^-|-$/g, ""); }
  s = s.replace(/^\+/, "");
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  let decimal = "";
  if (comma >= 0 && dot >= 0) decimal = comma > dot ? "," : ".";
  else if (comma >= 0 || dot >= 0) {
    const sep = comma >= 0 ? "," : ".";
    const single = s.split(sep).length === 2;
    if (single && s.length - s.lastIndexOf(sep) - 1 !== 3) decimal = sep;
  }
  const cut = decimal ? s.lastIndexOf(decimal) : s.length;
  const int = s.slice(0, cut).replace(/[.,]/g, "");
  const frac = decimal ? s.slice(cut + 1) : "";
  if (!/^\d*$/.test(int) || !/^\d*$/.test(frac) || (!int && !frac)) return null;
  const value = Math.round(Number(`${int || "0"}.${frac || "0"}`) * 100);
  return neg ? -value : value;
}

function resolveColumns(headers: string[], mapping: ColumnMapping): Partial<Record<ColumnKey, number>> {
  const cols: Partial<Record<ColumnKey, number>> = {};
  const normalized = headers.map(norm);
  const used = new Set<number>();
  for (const [key, aliases] of ALIASES) {
    const given = mapping[key] === "" ? undefined : mapping[key];
    let idx = -1;
    if (typeof given === "number") idx = given;
    else if (typeof given === "string" && given.trim()) idx = normalized.indexOf(norm(given));
    else if (given === undefined) {
      idx = normalized.findIndex(
        (h, i) => !used.has(i) && (key === "date" || !h.includes("fecha")) && !h.includes("saldo") && aliases.some((a) => h.includes(a)),
      );
    }
    if (given !== undefined && idx < 0) throw new CustomError(`No encuentro la columna "${given}" en el archivo`, 400, { headers });
    if (idx >= 0) { cols[key] = idx; used.add(idx); }
  }
  return cols;
}

export function parseStatement(csv: string, mapping: ColumnMapping = {}) {
  const rows = String(csv ?? "").replace(/^﻿/, "").split(/\r?\n/);
  const nonEmpty = rows.filter((r) => r.trim());
  if (!nonEmpty.length) throw new CustomError("El estado de cuenta está vacío", 400);
  const separator = detectSeparator(nonEmpty);
  const split = rows.map((r) => splitRow(r, separator));

  // El encabezado es la primera fila con una columna de fecha (los bancos ponen antes datos de la cuenta).
  const dateName = typeof mapping.date === "string" ? norm(mapping.date) : "";
  const headerIdx = typeof mapping.date === "number"
    ? -1
    : split.findIndex((cells) => cells.some((c) => (dateName ? norm(c) === dateName : norm(c).includes("fecha"))));
  const headers = headerIdx >= 0 ? split[headerIdx] : [];
  const cols = resolveColumns(headers, mapping);
  if (cols.date === undefined) throw new CustomError("No encuentro la columna de fecha: envía el mapeo de columnas", 400, { headers });
  if (cols.amount === undefined && cols.debit === undefined && cols.credit === undefined) {
    throw new CustomError("No encuentro las columnas de valores (débito/crédito o valor): envía el mapeo", 400, { headers });
  }

  const lines: StatementLine[] = [];
  split.forEach((cells, i) => {
    if (i <= headerIdx) return;
    const date = parseStatementDate(cells[cols.date!] ?? "");
    if (!date) return; // totales, saldos y pies de página
    const read = (k: ColumnKey) => (cols[k] === undefined ? "" : cells[cols[k]!] ?? "");
    const debit = Math.abs(parseAmount(read("debit")) ?? 0);
    const credit = Math.abs(parseAmount(read("credit")) ?? 0);
    const value = parseAmount(read("amount")) ?? 0;
    const [amount, direction]: [number, "in" | "out"] = debit
      ? [debit, "out"]
      : credit
        ? [credit, "in"]
        : [Math.abs(value), value < 0 ? "out" : "in"];
    if (!amount) return;
    lines.push({ line: i + 1, date, description: read("description"), reference: read("reference"), amount, direction });
  });
  return { separator, headers, columns: cols, lines };
}
