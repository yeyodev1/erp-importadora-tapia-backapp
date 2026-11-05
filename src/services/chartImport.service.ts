import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { Account, ACCOUNT_CODE, AccountKind } from "../models/account.model";
import { BankAccount } from "../models/bankAccount.model";
import { JournalEntry } from "../models/journalEntry.model";
import { Party } from "../models/party.model";
import { ProductGroup } from "../models/productGroup.model";
import { Settings } from "../models/settings.model";
import { WithholdingCode } from "../models/withholdingCode.model";

/**
 * Importa el plan de cuentas que entregue Tapia en CSV "código;nombre;tipo"
 * (tipo: mayor / movimiento). Previsualizar valida sin grabar; aplicar crea
 * las que faltan y actualiza nombre y tipo. Una cuenta que no viene en el
 * archivo se queda, salvo con `removeMissing` (cargar el plan real encima del
 * de ejemplo): entonces se quita si nada la usa.
 */
interface Row {
  line: number;
  code: string;
  name: string;
  kind: AccountKind;
}

const parentOf = (code: string) => (code.includes(".") ? code.slice(0, code.lastIndexOf(".")) : null);

function kindOf(value: string): AccountKind | null {
  const t = value.trim().toLowerCase();
  if (t === "m" || t.includes("mayor")) return "mayor";
  if (t === "v" || t.includes("mov")) return "movimiento";
  return null;
}

// shortcut: separa por ";" sin soportar ";" dentro de comillas; si el archivo real lo trae, usar un parser CSV.
function parseCsv(csv: string) {
  const rows: Row[] = [];
  const errors: string[] = [];
  csv
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      if (!raw.trim()) return;
      const [code = "", name = "", tipo = ""] = raw.split(";").map((c) => c.trim().replace(/^"(.*)"$/, "$1").trim());
      if (i === 0 && !/^\d/.test(code)) return; // encabezado
      const line = i + 1;
      const kind = kindOf(tipo);
      if (!ACCOUNT_CODE.test(code)) errors.push(`Línea ${line}: código "${code}" inválido (formato 9.9.99.99.99.999)`);
      else if (!name) errors.push(`Línea ${line}: la cuenta ${code} no tiene nombre`);
      else if (!kind) errors.push(`Línea ${line}: tipo "${tipo}" inválido en ${code} (mayor o movimiento)`);
      else rows.push({ line, code, name, kind });
    });
  return { rows, errors };
}

/** Por qué no se puede quitar cada cuenta que algo del sistema usa. */
async function usedCodes() {
  const [journal, settings, groups, banks, withholdings, suppliers] = await Promise.all([
    JournalEntry.distinct("lines.accountCode"),
    Settings.findById("main").lean<any>(),
    ProductGroup.find().select("accounts").lean<any[]>(),
    BankAccount.distinct("accountCode"),
    WithholdingCode.distinct("accountCode"),
    Party.distinct("supplier.defaultExpenseAccount"),
  ]);
  const why = new Map<string, string>();
  const mark = (codes: unknown[], reason: string) => codes.forEach((c) => c && !why.has(String(c)) && why.set(String(c), reason));
  mark(journal, "tiene asientos");
  mark(Object.values(settings?.accounts ?? {}), "está en el mapa de cuentas");
  mark(groups.flatMap((g) => Object.values(g.accounts ?? {})), "la usa un grupo de productos");
  mark(banks, "la usa una cuenta de banco o caja");
  mark(withholdings, "la usa un código de retención");
  mark(suppliers, "es la cuenta de gasto de un proveedor");
  return why;
}

/** Cuentas del sistema que no vienen en el archivo: se quitan las que nada usa; una que se queda deja también a sus padres. */
async function missingPlan(existing: any[], file: Map<string, Row>) {
  const why = await usedCodes();
  const missing = existing.filter((a) => !file.has(a.code));
  for (const a of missing.filter((m) => why.has(m.code))) {
    for (let p = parentOf(a.code); p && !file.has(p); p = parentOf(p)) if (!why.has(p)) why.set(p, `tiene la subcuenta ${a.code}`);
  }
  const pick = (a: any) => ({ code: a.code, name: a.name, kind: a.kind });
  return {
    toRemove: missing.filter((a) => !why.has(a.code)).map(pick),
    kept: missing.filter((a) => why.has(a.code)).map((a) => ({ ...pick(a), reason: why.get(a.code)! })),
  };
}

export async function importChart(body: any) {
  const csv = String(body?.csv ?? "");
  const mode = body?.mode === "apply" ? "apply" : "preview";
  const removeMissing = body?.removeMissing === true;
  if (!csv.trim()) throw new CustomError("Envía el plan de cuentas en el campo csv", 400);

  const { rows, errors } = parseCsv(csv);
  const existing = await Account.find().select("code name kind").lean<any[]>();
  const db = new Map(existing.map((a) => [a.code, a]));
  const file = new Map<string, Row>();
  for (const r of rows) {
    if (file.has(r.code)) errors.push(`Línea ${r.line}: el código ${r.code} está repetido (línea ${file.get(r.code)!.line})`);
    else file.set(r.code, r);
  }

  const { toRemove, kept } = removeMissing ? await missingPlan(existing, file) : { toRemove: [], kept: [] };
  const removed = new Set(toRemove.map((a) => a.code));
  const childParents = new Set([...file.keys(), ...db.keys()].filter((c) => !removed.has(c)).map(parentOf).filter(Boolean) as string[]);
  const used = new Set<string>(
    await JournalEntry.distinct("lines.accountCode", { "lines.accountCode": { $in: [...file.keys()] } }),
  );
  const toCreate: Row[] = [];
  const toUpdate: (Row & { previousName: string; previousKind: AccountKind })[] = [];
  let unchanged = 0;

  for (const r of file.values()) {
    const parent = parentOf(r.code);
    if (parent) {
      const parentKind = file.get(parent)?.kind ?? (removed.has(parent) ? undefined : db.get(parent)?.kind);
      if (!parentKind) errors.push(`Línea ${r.line}: la cuenta ${r.code} no tiene su cuenta padre ${parent}`);
      else if (parentKind !== "mayor") errors.push(`Línea ${r.line}: la cuenta padre ${parent} de ${r.code} debe ser de mayor`);
    }
    if (r.kind === "movimiento" && childParents.has(r.code)) {
      errors.push(`Línea ${r.line}: la cuenta ${r.code} tiene hijas; debe ser de mayor`);
    }
    const current = db.get(r.code);
    if (!current) {
      toCreate.push(r);
      continue;
    }
    if (current.kind === "movimiento" && r.kind === "mayor" && used.has(r.code)) {
      errors.push(`Línea ${r.line}: la cuenta ${r.code} tiene movimientos; no puede pasar a mayor`);
    }
    if (current.name !== r.name || current.kind !== r.kind) {
      toUpdate.push({ ...r, previousName: current.name, previousKind: current.kind });
    } else unchanged++;
  }

  const summary = { mode, valid: errors.length === 0, errors, toCreate, toUpdate, unchanged, toRemove, kept };
  if (mode === "preview") return summary;
  if (errors.length) {
    throw new CustomError(`El plan tiene ${errors.length} error(es); no se grabó nada. Primero: ${errors[0]}`, 400, errors);
  }

  await runInTransaction(async (session) => {
    if (toCreate.length) {
      await Account.insertMany(
        toCreate.map((r) => ({
          code: r.code,
          name: r.name,
          kind: r.kind,
          parentCode: parentOf(r.code),
          level: r.code.split(".").length,
          isExpense: r.code.startsWith("5.2"), // igual que el seed: 5.2 son los gastos en el plan de Tapia
        })),
        { session },
      );
    }
    if (toUpdate.length) {
      await Account.bulkWrite(
        toUpdate.map((r) => ({ updateOne: { filter: { code: r.code }, update: { $set: { name: r.name, kind: r.kind } } } })),
        { session },
      );
    }
    if (removed.size) await Account.deleteMany({ code: { $in: [...removed] } }, { session });
  });
  return { ...summary, created: toCreate.length, updated: toUpdate.length, removed: removed.size };
}
