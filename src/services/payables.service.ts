import { ClientSession, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { Party } from "../models/party.model";
import { PayableApplication, IPayableApplication } from "../models/payableApplication.model";
import { PaymentApproval } from "../models/paymentApproval.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { cents, formatCents, sum } from "../utils/money";
import { parseDay, TIMEZONE } from "../utils/dates";
import type { Actor } from "./accounting.service";
import * as sequenceService from "./sequence.service";

/**
 * Saldo por factura = neto a pagar − pagos ejecutados − NC − cruces de anticipo.
 * Todo abono pasa por applyToInvoices (valida y deja la fila con fecha) y se
 * deshace con unapply al anular el documento que lo originó.
 */
export interface InvoiceAmount {
  invoiceId: string | Types.ObjectId;
  amount: number;
}

/** Fecha del documento; si no viene, hoy en Ecuador. */
export function docDate(value: unknown): Date {
  return parseDay(value || new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE }));
}

/** Valida líneas {invoiceId, amount} de la API: centavos > 0 y sin facturas repetidas. */
export function parseLines(raw: unknown): InvoiceAmount[] {
  if (!Array.isArray(raw) || !raw.length) throw new CustomError("Indica las facturas y los valores", 400);
  const lines = raw.map((l: any) => ({ invoiceId: String(l?.invoiceId ?? ""), amount: cents(l?.amount, "valor") }));
  if (lines.some((l) => !Types.ObjectId.isValid(l.invoiceId))) throw new CustomError("Factura inválida", 400);
  if (lines.some((l) => l.amount <= 0)) throw new CustomError("Cada valor debe ser mayor que cero", 400);
  if (new Set(lines.map((l) => l.invoiceId)).size !== lines.length) throw new CustomError("Hay facturas repetidas", 400);
  return lines;
}

/**
 * Abona a facturas. Un abono directo (NC, cruce) solo toma lo no aprobado;
 * un pago ejecutado consume lo aprobado (consumeApproved).
 */
export async function applyToInvoices(
  lines: InvoiceAmount[],
  kind: IPayableApplication["kind"],
  sourceId: Types.ObjectId,
  date: Date,
  session: ClientSession,
  consumeApproved = false,
) {
  const out: { invoiceId: Types.ObjectId; supplierId: Types.ObjectId; amount: number }[] = [];
  for (const line of lines) {
    const inv = await PurchaseInvoice.findById(line.invoiceId).session(session);
    if (!inv || inv.status !== "vigente") throw new CustomError("Factura de proveedor no encontrada o anulada", 404);
    const available = consumeApproved ? Math.min(inv.approved, inv.balance) : inv.balance - inv.approved;
    if (line.amount > available) {
      throw new CustomError(
        `La factura ${inv.docNumber} solo admite ${formatCents(available)}${consumeApproved ? " aprobados" : " (saldo no aprobado)"}`,
        409,
      );
    }
    inv.balance -= line.amount;
    if (consumeApproved) inv.approved -= line.amount;
    await inv.save({ session });
    await PayableApplication.create(
      [{ invoiceId: inv._id, supplierId: inv.supplierId, date, kind, amount: line.amount, sourceId }],
      { session },
    );
    out.push({ invoiceId: inv._id, supplierId: inv.supplierId, amount: line.amount });
  }
  return out;
}

/** Anula los abonos de un documento y devuelve el saldo a sus facturas. */
export async function unapply(sourceId: Types.ObjectId | string, session: ClientSession) {
  const apps = await PayableApplication.find({ sourceId, status: "vigente" }).session(session);
  for (const a of apps) {
    await PurchaseInvoice.updateOne({ _id: a.invoiceId }, { $inc: { balance: a.amount } }, { session });
    a.status = "anulado";
    await a.save({ session });
  }
}

/**
 * Aprueba pagos totales o parciales. Con facturas de varios proveedores hay
 * que decir a nombre de quién sale el pago (beneficiaryId); con uno solo, es él.
 */
export async function approve(body: any, actor: Actor) {
  const lines = parseLines(body?.lines);
  const date = docDate(body?.date);
  return runInTransaction(async (session) => {
    const resolved = [];
    for (const line of lines) {
      const inv = await PurchaseInvoice.findById(line.invoiceId).session(session);
      if (!inv || inv.status !== "vigente") throw new CustomError("Factura de proveedor no encontrada o anulada", 404);
      const available = inv.balance - inv.approved;
      if (line.amount > available) {
        throw new CustomError(`La factura ${inv.docNumber} tiene ${formatCents(available)} por aprobar`, 409);
      }
      inv.approved += line.amount;
      await inv.save({ session });
      resolved.push({ invoiceId: inv._id, supplierId: inv.supplierId, amount: line.amount });
    }
    const suppliers = [...new Set(resolved.map((l) => String(l.supplierId)))];
    const beneficiaryId = body?.beneficiaryId ?? (suppliers.length === 1 ? suppliers[0] : null);
    if (!beneficiaryId) throw new CustomError("Con varios proveedores indica el beneficiario del pago", 400);
    if (!(await Party.exists({ _id: beneficiaryId }).session(session))) throw new CustomError("Beneficiario no encontrado", 404);

    const number = await sequenceService.next("aprobacion-pago", session);
    const [approval] = await PaymentApproval.create(
      [
        {
          number,
          date,
          beneficiaryId,
          lines: resolved,
          total: sum(resolved.map((l) => l.amount)),
          note: String(body?.note ?? ""),
          createdBy: actor,
        },
      ],
      { session },
    );
    return approval.toObject();
  });
}

/** Quita una aprobación que todavía no se pagó: el valor vuelve a quedar por aprobar. */
export async function cancelApproval(id: string) {
  return runInTransaction(async (session) => {
    const approval = await PaymentApproval.findById(id).session(session);
    if (!approval) throw new CustomError("Aprobación no encontrada", 404);
    if (approval.status !== "pendiente") throw new CustomError("Solo se anula una aprobación pendiente de pago", 409);
    for (const l of approval.lines) {
      await PurchaseInvoice.updateOne({ _id: l.invoiceId }, { $inc: { approved: -l.amount } }, { session });
    }
    approval.status = "anulada";
    await approval.save({ session });
    return approval.toObject();
  });
}

export async function listApprovals(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.beneficiaryId) filter.beneficiaryId = query.beneficiaryId;
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  const [items, total] = await Promise.all([
    PaymentApproval.find(filter)
      .sort({ date: -1, number: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("beneficiaryId", "name identification")
      .populate("lines.invoiceId", "docNumber date total payable balance")
      .lean(),
    PaymentApproval.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}
