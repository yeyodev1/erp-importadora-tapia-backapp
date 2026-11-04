import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { BankMovement } from "../models/bankMovement.model";
import { cents, formatCents } from "../utils/money";
import { parseDay } from "../utils/dates";
import type { Actor } from "./accounting.service";
import { createTransaction } from "./bankTransactions.service";
import { getReconciliation, loadedMovements, openReconciliation, toLoadedIds } from "./bankReconciliation.service";
import { ColumnMapping, parseStatement, StatementLine } from "./bankStatementParser.service";

/**
 * Conciliación semiautomática: se cruza el estado de cuenta con los
 * movimientos cargados y se devuelven PROPUESTAS. Nada se graba hasta que el
 * contador confirma los ids aceptados (confirmMatches).
 */
const DAY_MS = 86_400_000;
const MAX_DAYS = 3;

const digits = (s: string) => (s.match(/\d+/g) ?? []).map((n) => n.replace(/^0+/, "")).filter(Boolean);

export function matchLines(lines: StatementLine[], movements: any[]) {
  const free = new Map(movements.map((m) => [String(m._id), m]));
  const proposals: { movementId: string; movement: any; line: StatementLine; rule: "cheque" | "monto_fecha" }[] = [];
  const take = (m: any, line: StatementLine, rule: "cheque" | "monto_fecha") => {
    free.delete(String(m._id));
    proposals.push({ movementId: String(m._id), movement: pick(m), line, rule });
  };

  // 1) Número de cheque + monto. La referencia manda; si viene vacía, el número suele estar en la descripción.
  const rest: StatementLine[] = [];
  for (const line of lines) {
    const nums = new Set(digits(line.reference || line.description));
    const check = line.direction === "out" && nums.size
      ? [...free.values()].find(
          (m) => m.direction === "out" && m.checkNumber && nums.has(String(m.checkNumber).replace(/^0+/, "")) && m.amount === line.amount,
        )
      : undefined;
    if (check) take(check, line, "cheque");
    else rest.push(line);
  }

  // 2) Monto exacto + fecha ±3 días, solo si hay un único candidato (dos cheques iguales los decide el contador).
  const unmatchedLines: StatementLine[] = [];
  for (const line of rest) {
    const candidates = [...free.values()].filter(
      (m) => m.direction === line.direction && m.amount === line.amount &&
        Math.abs(new Date(m.date).getTime() - line.date.getTime()) <= MAX_DAYS * DAY_MS,
    );
    if (candidates.length === 1) take(candidates[0], line, "monto_fecha");
    else unmatchedLines.push(line);
  }

  const unmatchedMovements = [...free.values()].filter((m) => !m.cleared).map(pick);
  return { proposals, unmatchedLines, unmatchedMovements };
}

const pick = (m: any) => ({
  _id: m._id, date: m.date, type: m.type, direction: m.direction, amount: m.amount,
  checkNumber: m.checkNumber, description: m.description, cleared: !!m.cleared,
});

/** Lee el CSV y propone emparejamientos. Solo lectura. */
export async function matchStatement(id: string, body: Record<string, any>) {
  if (typeof body?.csv !== "string" || !body.csv.trim()) throw new CustomError("Pega o sube el estado de cuenta (CSV)", 400);
  const rec = await openReconciliation(id);
  const parsed = parseStatement(body.csv, (body.mapping ?? {}) as ColumnMapping);
  const movements = await loadedMovements(rec);
  const result = matchLines(parsed.lines, movements);
  return {
    separator: parsed.separator,
    headers: parsed.headers,
    columns: parsed.columns,
    totalLines: parsed.lines.length,
    ...result,
  };
}

/** Marca como cobrados los movimientos que el contador aceptó (se suman a las marcas existentes). */
export async function confirmMatches(id: string, body: Record<string, any>) {
  if (!Array.isArray(body?.movementIds) || !body.movementIds.length) {
    throw new CustomError("Indica los movimientos aceptados", 400);
  }
  const rec = await openReconciliation(id);
  const accepted = toLoadedIds(rec, body.movementIds);
  const have = new Set(rec.clearedIds.map(String));
  rec.clearedIds.push(...accepted.filter((a) => !have.has(String(a))));
  await rec.save();
  return getReconciliation(id);
}

/**
 * Línea del extracto que no está en libros (comisión, interés, crédito del
 * banco): la convierte en nota de débito/crédito contra la cuenta elegida y
 * la deja cargada y marcada como cobrada en esta conciliación.
 */
export async function noteFromLine(id: string, body: Record<string, any>, actor: Actor) {
  const line = body?.line ?? {};
  const amount = cents(line.amount, "valor de la línea");
  if (amount <= 0) throw new CustomError("El valor de la línea debe ser mayor que cero", 400);
  if (line.direction !== "in" && line.direction !== "out") throw new CustomError("La línea no tiene débito o crédito", 400);
  const accountCode = String(body?.accountCode ?? "").trim();
  if (!accountCode) throw new CustomError("Elige la cuenta contable", 400);
  // Llega como ISO por HTTP o como Date si se reusa la propuesta en el servidor.
  const date = parseDay(line.date instanceof Date ? line.date.toISOString() : line.date);

  await runInTransaction(async (session) => {
    const rec = await openReconciliation(id, session);
    if (date > rec.to) throw new CustomError("La línea es posterior al corte de la conciliación", 400);
    const type = line.direction === "out" ? "NOTA_DEBITO" : "NOTA_CREDITO";
    const tx = await createTransaction(
      {
        type,
        bankAccountId: String(rec.bankAccountId),
        date: date.toISOString(),
        note: String(line.description ?? "").trim() || `${type === "NOTA_DEBITO" ? "Débito" : "Crédito"} bancario ${formatCents(amount)}`,
        lines: [{ accountCode, amount, costCenter: body.costCenter ?? "", description: String(line.description ?? "") }],
      },
      actor,
      session,
    );
    const movement = await BankMovement.findOne({ "source.docId": tx._id }).session(session);
    rec.movementIds.push(movement!._id);
    rec.clearedIds.push(movement!._id);
    await rec.save({ session });
  });
  return getReconciliation(id);
}
