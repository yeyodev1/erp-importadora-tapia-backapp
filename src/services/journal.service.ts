import { isValidObjectId, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { Account } from "../models/account.model";
import { ENTRY_TYPES, JournalEntry } from "../models/journalEntry.model";
import { Party } from "../models/party.model";
import { dayRange, parseDay, TIMEZONE } from "../utils/dates";
import { cents } from "../utils/money";
import { escapeRegex } from "../utils/regex";
import { Actor, postEntry, reverseEntry } from "./accounting.service";
import { entryMatch, isTrue, subtreeOf, todayStr } from "./ledgerReports.service";

/**
 * Comprobantes manuales de contabilidad. Según Tapia solo estos se hacen a
 * mano; todos son tipo DIARIO y el subtipo se guarda en source.docType.
 */
export const MANUAL_SUBTYPES: Record<string, string> = {
  asiento_diario: "Asiento de diario",
  depreciacion: "Depreciación",
  importacion: "Importación",
  rol_pagos: "Rol de pagos",
};

const MODULE = "contabilidad";

function withSubtype<T extends { type: string; source: { module: string; docType: string } }>(e: T) {
  const isManual = e.type === "DIARIO" && e.source.module === MODULE;
  return { ...e, subtype: isManual ? e.source.docType || "asiento_diario" : null };
}

function assertId(id: string) {
  if (!isValidObjectId(id)) throw new CustomError("Asiento no encontrado", 404);
}

export async function createManual(body: any, actor: Actor) {
  const subtype = String(body?.subtype ?? "asiento_diario");
  if (!MANUAL_SUBTYPES[subtype]) {
    throw new CustomError(`Subtipo inválido. Usa: ${Object.keys(MANUAL_SUBTYPES).join(", ")}`, 400);
  }
  const date = parseDay(body?.date);
  const description = String(body?.description ?? "").trim();
  if (!description) throw new CustomError("La descripción del comprobante es obligatoria", 400);
  if (!Array.isArray(body?.lines)) throw new CustomError("El comprobante necesita líneas", 400);

  const lines = body.lines.map((l: any, i: number) => {
    const partyId = l?.partyId ? String(l.partyId) : null;
    if (partyId && !isValidObjectId(partyId)) throw new CustomError(`Tercero inválido en la línea ${i + 1}`, 400);
    return {
      accountCode: String(l?.accountCode ?? "").trim(),
      debit: cents(l?.debit ?? 0, `debe de la línea ${i + 1}`),
      credit: cents(l?.credit ?? 0, `haber de la línea ${i + 1}`),
      costCenter: String(l?.costCenter ?? "").trim(),
      partyId: partyId ? new Types.ObjectId(partyId) : null,
      description: String(l?.description ?? "").trim(),
    };
  });

  const partyIds = [...new Set(lines.filter((l: any) => l.partyId).map((l: any) => String(l.partyId)))];
  if (partyIds.length && (await Party.countDocuments({ _id: { $in: partyIds } })) !== partyIds.length) {
    throw new CustomError("Uno de los terceros del comprobante no existe", 400);
  }
  // postEntry no conoce centros de costo: la cuenta que los controla los exige aquí.
  const needCc = new Set<string>(
    await Account.find({ code: { $in: lines.map((l: any) => l.accountCode) }, requiresCostCenter: true }).distinct("code"),
  );
  const missing = lines.find((l: any) => needCc.has(l.accountCode) && !l.costCenter && (l.debit || l.credit));
  if (missing) throw new CustomError(`La cuenta ${missing.accountCode} exige centro de costo`, 400);

  const entry = await runInTransaction((session) =>
    postEntry(
      { date, type: "DIARIO", description, source: { module: MODULE, docType: subtype }, lines },
      actor,
      session,
    ),
  );
  return withSubtype(entry as any);
}

/** Anula un comprobante manual con su reverso. Lo de otros módulos se anula desde su documento. */
export async function voidManual(id: string, body: any, actor: Actor) {
  assertId(id);
  const reason = String(body?.reason ?? "").trim();
  if (!reason) throw new CustomError("Indica el motivo de la anulación", 400);
  const entry = await JournalEntry.findById(id).lean<any>();
  if (!entry) throw new CustomError("Asiento no encontrado", 404);
  if (entry.source.module !== MODULE) {
    const doc = [entry.source.docType, entry.source.docNumber].filter(Boolean).join(" ");
    throw new CustomError(
      `El asiento ${entry.number} lo generó el módulo ${entry.source.module}${doc ? ` (${doc})` : ""}: se anula desde su módulo`,
      409,
    );
  }
  if (entry.type === "CIERRE") throw new CustomError("El asiento de cierre se anula reabriendo el año (Cierre anual)", 409);
  if (entry.type === "REVERSO") throw new CustomError("Un reverso no se anula: registra un comprobante nuevo", 409);
  const date = parseDay(body?.date ?? todayStr());
  return runInTransaction((session) => reverseEntry(id, reason, date, actor, session));
}

/** Consulta de un comprobante con terceros, auditoría (usuario, fecha y hora) y documento origen. */
export async function getEntry(id: string) {
  assertId(id);
  const entry = await JournalEntry.findById(id).populate("lines.partyId", "name identification").lean<any>();
  if (!entry) throw new CustomError("Asiento no encontrado", 404);
  const linkedIds = [entry.reversedBy, entry.reversalOf].filter(Boolean);
  const linked = linkedIds.length
    ? await JournalEntry.find({ _id: { $in: linkedIds } }).select("number date type").lean<any[]>()
    : [];
  const byId = (oid: unknown) => linked.find((l) => String(l._id) === String(oid)) ?? null;
  const created = entry.createdAt ? new Date(entry.createdAt) : null;
  return {
    ...withSubtype(entry),
    lines: entry.lines.map((l: any) => ({ ...l, party: l.partyId ?? null, partyId: l.partyId?._id ?? null })),
    audit: {
      user: entry.createdBy?.name ?? "",
      userId: entry.createdBy?.userId ?? null,
      date: created?.toLocaleDateString("en-CA", { timeZone: TIMEZONE }) ?? null,
      time: created?.toLocaleTimeString("en-GB", { timeZone: TIMEZONE, hour12: false }) ?? null,
      createdAt: entry.createdAt ?? null,
    },
    sourceDocument: { ...entry.source, editable: entry.source.module === MODULE },
    reversedByEntry: byId(entry.reversedBy),
    reversalOfEntry: byId(entry.reversalOf),
  };
}

/** Búsqueda de asientos: fecha, tipo, número, cuenta (con hijas), módulo, texto, monto (centavos). */
export async function search(q: Record<string, unknown>) {
  const filter: Record<string, unknown> = entryMatch(dayRange(q.from, q.to), isTrue(q.excludeVoided));
  if (q.type) {
    if (!ENTRY_TYPES.includes(q.type as any)) throw new CustomError("Tipo de asiento inválido", 400);
    filter.type = q.type;
  }
  if (q.subtype) filter["source.docType"] = String(q.subtype);
  if (q.number) filter.number = new RegExp(escapeRegex(String(q.number)), "i");
  if (q.account) filter["lines.accountCode"] = subtreeOf(String(q.account).trim());
  if (q.module) filter["source.module"] = String(q.module);
  if (q.status) filter.status = String(q.status);
  if (q.amount !== undefined && q.amount !== "") filter.totalDebit = cents(q.amount, "monto");
  if (q.q) {
    const rx = new RegExp(escapeRegex(String(q.q)), "i");
    filter.$or = [{ description: rx }, { "source.docNumber": rx }, { "lines.description": rx }];
  }
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(q.limit) || 50));
  const [items, total] = await Promise.all([
    JournalEntry.find(filter).select("-lines").sort({ date: -1, number: -1 }).skip((page - 1) * limit).limit(limit).lean<any[]>(),
    JournalEntry.countDocuments(filter),
  ]);
  return { items: items.map(withSubtype), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}
