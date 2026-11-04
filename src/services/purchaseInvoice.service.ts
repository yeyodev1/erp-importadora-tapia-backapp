import { Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { PayableApplication } from "../models/payableApplication.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { escapeRegex } from "../utils/regex";
import { dayRange } from "../utils/dates";
import { roundUnitCost } from "../utils/money";
import * as accounting from "./accounting.service";
import type { Actor, EntryLineInput } from "./accounting.service";
import * as inventoryCore from "./inventoryCore.service";
import * as sequenceService from "./sequence.service";
import * as sri from "./sri";
import { buildInvoice } from "./purchaseInvoiceInput.service";
import { findDuplicate } from "./purchaseXml.service";
import { docDate } from "./payables.service";
import { sriStatusFilter } from "./salesCommon.service";

/**
 * Factura de proveedor. Asiento COMPRA: Debe gasto/inventario + IVA pagado;
 * Haber retención IR, retención IVA y Proveedores (neto a pagar). Si hay
 * retenciones, numera el comprobante de retención y lo manda al SRI después
 * de grabar (el SRI caído nunca impide registrar la compra).
 */
export async function createInvoice(body: any, actor: Actor) {
  const { supplier, data } = await buildInvoice(body);
  const establishment = String(body?.withholdingEstablishment ?? "001");
  const emissionPoint = String(body?.withholdingEmissionPoint ?? "001");
  if (!/^\d{3}$/.test(establishment) || !/^\d{3}$/.test(emissionPoint)) {
    throw new CustomError("Establecimiento y punto de emisión de la retención: 3 dígitos", 400);
  }

  const saved = await runInTransaction(async (session) => {
    const dup = await findDuplicate(data, session);
    if (dup) throw new CustomError(`La factura ${data.docNumber} de ${data.supplierName} ya está ingresada`, 409, { existingId: dup._id });

    const _id = new Types.ObjectId();
    const source = { module: "compras", docType: "FACTURA_COMPRA", docId: _id, docNumber: data.docNumber };
    if (data.productLines.length) {
      await inventoryCore.applyMovement(
        {
          warehouseId: data.warehouseId!,
          date: data.date,
          type: "INGRESO_COMPRA",
          partyId: supplier._id,
          source,
          lines: data.productLines.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: roundUnitCost(l.subtotal / 100 / l.qty) })),
        },
        actor,
        session,
      );
    }

    // El inventario se debita con el subtotal facturado; el kardex lo guarda con costo unitario de 6 decimales.
    const lines: EntryLineInput[] = [
      ...data.expenseLines.map((l: any) => ({ accountCode: l.accountCode, debit: l.base0 + l.baseVat, costCenter: l.costCenter, description: l.description })),
      ...data.productLines.map((l) => ({ accountCode: l.accountCode, debit: l.subtotal, description: l.description })),
      { accountCode: await accounting.mappedAccount("vatPurchases", session), debit: data.vat },
      ...data.withholdings.map((w) => ({ accountCode: w.accountCode, credit: w.amount, partyId: supplier._id, description: `Ret. ${w.code} ${w.rate}%` })),
      { accountCode: await accounting.mappedAccount("suppliers", session), credit: data.payable, partyId: supplier._id },
    ];

    const withholding = data.withholdings.length
      ? { number: (await sequenceService.nextDocNumber("retencion", establishment, emissionPoint, session)).number, sriStatus: "pendiente" }
      : null;

    const entry = await accounting.postEntry(
      {
        date: data.date,
        type: "COMPRA",
        description: `${data.docType === "01" ? "Factura" : "Comprobante"} ${data.docNumber} de ${data.supplierName}${data.description ? ` — ${data.description}` : ""}`,
        source,
        lines,
      },
      actor,
      session,
    );
    const [doc] = await PurchaseInvoice.create(
      [{ _id, ...data, withholding, journalEntryId: entry._id, createdBy: actor }],
      { session },
    );
    return doc.toObject();
  });

  if (saved.withholding) await issueWithholding(saved, supplier);
  return PurchaseInvoice.findById(saved._id).lean();
}

/** Arma el SriPayload del comprobante de retención (07) y guarda lo que responda el SRI. */
async function issueWithholding(inv: any, supplier: any) {
  const [establishment, emissionPoint, sequential] = inv.withholding.number.split("-");
  const payload: sri.SriPayload = {
    kind: "retencion",
    establishment,
    emissionPoint,
    sequential,
    issueDate: inv.date,
    buyer: {
      idType: supplier.idType,
      identification: supplier.identification,
      name: supplier.name,
      address: supplier.address,
      email: supplier.email,
    },
    lines: [],
    totals: { subtotal0: inv.base0, subtotalVat: inv.baseVat, vat: inv.vat, discount: 0, total: inv.total },
    paymentMethod: inv.paymentMethod,
    withholding: {
      supportCode: inv.taxSupport,
      fiscalPeriod: `${String(inv.date.getUTCMonth() + 1).padStart(2, "0")}/${inv.date.getUTCFullYear()}`,
      lines: inv.withholdings.map((w: any) => ({
        tax: w.tax === "renta" ? "1" : "2",
        code: w.code,
        rate: w.rate,
        base: w.base,
        amount: w.amount,
        supportDocCode: inv.docType,
        supportDocNumber: inv.docNumber,
        supportDocDate: inv.date,
        supportDocAuthorization: inv.authorization || undefined,
      })),
    },
  };
  let result: sri.SriResult;
  try {
    result = await sri.issue(payload);
  } catch (error: any) {
    result = { accessKey: "", status: "error", authorizationNumber: "", authorizationDate: null, messages: [error?.message ?? "Error SRI"], xml: "" };
  }
  await PurchaseInvoice.updateOne(
    { _id: inv._id },
    {
      "withholding.accessKey": result.accessKey,
      "withholding.sriStatus": result.status,
      "withholding.authorizationNumber": result.authorizationNumber,
      "withholding.messages": result.messages,
      "withholding.xml": result.xml,
    },
  );
}

/** Reenvía al SRI la retención que no se autorizó (SRI caído, falta la firma). */
export async function resendWithholding(id: string) {
  const inv = await PurchaseInvoice.findById(id).populate("supplierId").lean<any>();
  if (!inv?.withholding) throw new CustomError("La factura no tiene comprobante de retención", 404);
  if (inv.withholding.sriStatus === "autorizado") throw new CustomError("La retención ya está autorizada", 409);
  await issueWithholding({ ...inv, supplierId: inv.supplierId._id }, inv.supplierId);
  return PurchaseInvoice.findById(id).lean();
}

/** Anula la factura si no tiene abonos ni aprobaciones: reversa el asiento y saca la mercadería. */
export async function voidInvoice(id: string, body: any, actor: Actor) {
  const reason = String(body?.reason ?? "").trim();
  if (!reason) throw new CustomError("Indica el motivo de la anulación", 400);
  const date = docDate(body?.date);
  return runInTransaction(async (session) => {
    const inv = await PurchaseInvoice.findById(id).session(session);
    if (!inv) throw new CustomError("Factura de proveedor no encontrada", 404);
    if (inv.status === "anulado") throw new CustomError("La factura ya está anulada", 409);
    const applied = await PayableApplication.countDocuments({ invoiceId: inv._id, status: "vigente" }).session(session);
    if (applied || inv.approved > 0) {
      throw new CustomError("La factura tiene pagos, aprobaciones, notas de crédito o cruces; anúlalos primero", 409);
    }
    await accounting.reverseBySource(inv._id, reason, date, actor, session);
    if (inv.productLines.length) {
      await inventoryCore.applyMovement(
        {
          warehouseId: inv.warehouseId!,
          date,
          type: "NOTA_CREDITO_COMPRA",
          partyId: inv.supplierId,
          source: { module: "compras", docType: "ANULA_FACTURA_COMPRA", docId: inv._id, docNumber: inv.docNumber },
          lines: inv.productLines.map((l: any) => ({ productId: l.productId, qty: l.qty })),
        },
        actor,
        session,
      );
    }
    inv.status = "anulado";
    inv.voidReason = reason;
    inv.balance = 0;
    await inv.save({ session });
    return inv.toObject();
  });
}

export async function getInvoice(id: string) {
  const inv = await PurchaseInvoice.findById(id).populate("supplierId", "name identification").lean();
  if (!inv) throw new CustomError("Factura de proveedor no encontrada", 404);
  const applications = await PayableApplication.find({ invoiceId: id }).sort({ date: 1 }).lean();
  return { ...inv, applications };
}

/** Listado; ?pending=true deja solo las que tienen saldo (la grilla de "Aprueba pagos"). */
export async function listInvoices(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = {};
  filter.status = query.status ?? "vigente";
  if (query.supplierId) filter.supplierId = query.supplierId;
  if (query.supplierIds) filter.supplierId = { $in: String(query.supplierIds).split(",") };
  if (query.pending === "true") filter.balance = { $gt: 0 };
  if (query.q) {
    const rx = new RegExp(escapeRegex(String(query.q)), "i");
    filter.$or = [{ docNumber: rx }, { supplierName: rx }, { supplierRuc: rx }, { accessKey: rx }];
  }
  const range = dayRange(query.from, query.to);
  if (range) filter.date = range;
  Object.assign(filter, sriStatusFilter(query, "withholding.sriStatus"));
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 50));
  const [items, total] = await Promise.all([
    PurchaseInvoice.find(filter).select("-withholding.xml").sort({ date: -1, docNumber: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    PurchaseInvoice.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}
