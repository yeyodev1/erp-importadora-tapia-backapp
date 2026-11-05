import { Model, Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { SalesInvoice, ICustomerSnapshot, ISalesInvoice, ISaleLine } from "../models/salesInvoice.model";
import type { ISalesCreditNote } from "../models/salesCreditNote.model";
import type { ISalesDebitNote } from "../models/salesDebitNote.model";
import * as sri from "./sri";
import type { SriPayload } from "./sri";

/**
 * Traduce los documentos de venta al contrato SRI y guarda el resultado.
 * Se llama DESPUÉS de confirmar la transacción: el SRI nunca bloquea la grabación.
 */
const buyer = (c: ICustomerSnapshot) => ({
  idType: c.idType, identification: c.identification, name: c.name, address: c.address, email: c.email,
});

const sriLines = (lines: ISaleLine[]) =>
  lines.map((l) => ({
    code: l.code, description: l.name, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount, subtotal: l.subtotal, vatRate: l.vatRate,
  }));

const totals = (d: { subtotal0: number; subtotalVat: number; vat: number; discount: number; total: number }) => ({
  subtotal0: d.subtotal0, subtotalVat: d.subtotalVat, vat: d.vat, discount: d.discount, total: d.total,
});

export function invoicePayload(inv: ISalesInvoice): SriPayload {
  return {
    kind: "factura", establishment: inv.establishment, emissionPoint: inv.emissionPoint, sequential: inv.sequential,
    issueDate: inv.date, buyer: buyer(inv.customer), lines: sriLines(inv.lines), totals: totals(inv),
    paymentMethod: inv.paymentMethod, creditDays: inv.creditDays,
    additionalInfo: { Vendedor: inv.sellerName, ...(inv.orderRef ? { Pedido: inv.orderRef } : {}), ...(inv.notes ? { Observacion: inv.notes } : {}) },
  };
}

export function creditNotePayload(cn: ISalesCreditNote, inv: ISalesInvoice): SriPayload {
  return {
    kind: "notaCredito", establishment: cn.establishment, emissionPoint: cn.emissionPoint, sequential: cn.sequential,
    issueDate: cn.date, buyer: buyer(inv.customer), lines: sriLines(cn.lines), totals: totals(cn),
    modifies: { docCode: "01", number: inv.number, date: inv.date, reason: cn.reason },
  };
}

export function debitNotePayload(dn: ISalesDebitNote, inv: ISalesInvoice): SriPayload {
  const base = dn.subtotal0 + dn.subtotalVat;
  return {
    kind: "notaDebito", establishment: dn.establishment, emissionPoint: dn.emissionPoint, sequential: dn.sequential,
    issueDate: dn.date, buyer: buyer(inv.customer),
    lines: [{ code: "ND", description: dn.reason, qty: 1, unitPrice: base, discount: 0, subtotal: base, vatRate: dn.vatRate }],
    totals: totals(dn),
    modifies: { docCode: "01", number: inv.number, date: inv.date, reason: dn.reason },
  };
}

async function save(model: Model<any>, id: Types.ObjectId, run: () => Promise<sri.SriResult>) {
  let set: Record<string, unknown>;
  try {
    const r = await run();
    set = {
      accessKey: r.accessKey, sriStatus: r.status, authorizationNumber: r.authorizationNumber,
      authorizationDate: r.authorizationDate, sriMessages: r.messages, xml: r.xml,
    };
  } catch (error: any) {
    set = { sriStatus: "error", sriMessages: [String(error?.message ?? error)] };
  }
  return model.findByIdAndUpdate(id, set, { new: true }).select("-xml").lean();
}

type Kind = "invoice" | "creditNote" | "debitNote";

async function payloadOf(kind: Kind, doc: any): Promise<SriPayload> {
  if (kind === "invoice") return invoicePayload(doc);
  const inv = await SalesInvoice.findById(doc.invoiceId).lean<ISalesInvoice>();
  if (!inv) throw new CustomError("Factura del documento no encontrada", 404);
  return kind === "creditNote" ? creditNotePayload(doc, inv) : debitNotePayload(doc, inv);
}

/** Emite el comprobante recién grabado. */
export async function emit(model: Model<any>, kind: Kind, id: Types.ObjectId) {
  const doc = await model.findById(id).lean();
  if (!doc) throw new CustomError("Documento no encontrado", 404);
  const payload = await payloadOf(kind, doc);
  return save(model, id, () => sri.issue(payload));
}

/** Reintento: si ya tiene clave de acceso se reconsulta; si no, se vuelve a emitir. */
export async function retry(model: Model<any>, kind: Kind, id: unknown) {
  const doc = await model.findById(String(id)).lean<any>();
  if (!doc) throw new CustomError("Documento no encontrado", 404);
  if (doc.status === "anulado") throw new CustomError("El documento está anulado", 409);
  if (doc.isOpening) throw new CustomError("Es un saldo inicial migrado de Macio: no se envía al SRI", 409);
  if (doc.sriStatus === "autorizado") throw new CustomError("El comprobante ya está autorizado", 409);
  // Devuelto o no autorizado hay que reemitirlo; lo demás (recibido, error de red) se reconsulta.
  if (doc.accessKey && !["devuelto", "no_autorizado"].includes(doc.sriStatus)) {
    return save(model, doc._id, () => sri.retry(doc.accessKey, doc.xml));
  }
  const payload = await payloadOf(kind, doc);
  return save(model, doc._id, () => sri.issue(payload));
}
