import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { runInTransaction } from "../config/transaction";
import { SalesInvoice } from "../models/salesInvoice.model";
import { SalesWithholding } from "../models/salesWithholding.model";
import { cents, formatCents, percentOf, sum } from "../utils/money";
import { dayRange, parseDay } from "../utils/dates";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import { addAr } from "./arLedger.service";
import { oid, paginate, requireText } from "./salesCommon.service";

/**
 * Retención que el cliente nos hace sobre una factura. Renta sobre la base
 * (subtotales sin IVA) al 1 %, 1,75 %, 2 %...; IVA sobre el IVA facturado al
 * 10 %–100 %. Asiento RETENCION_VENTA: Debe retenciones por cobrar, Haber Clientes.
 */
const VAT_RATES = [10, 20, 30, 50, 70, 100];

export interface WithholdingBody {
  invoiceId: unknown;
  date: unknown;
  voucherNumber?: string;
  authorization?: string;
  lines: { tax: "renta" | "iva"; rate: unknown; base?: unknown }[];
}

export async function createWithholding(body: WithholdingBody, actor: Actor) {
  const voucherNumber = requireText(body.voucherNumber, "el número del comprobante de retención");
  const date = parseDay(body.date);
  if (!Array.isArray(body.lines) || body.lines.length === 0) throw new CustomError("La retención necesita al menos una línea", 400);

  return runInTransaction(async (session) => {
    const invoice = await SalesInvoice.findById(oid(body.invoiceId, "factura")).session(session).lean<any>();
    if (!invoice || invoice.status !== "vigente") throw new CustomError("Factura no encontrada o anulada", 404);
    if (date < invoice.date) throw new CustomError("La retención no puede ser anterior a la factura", 400);

    const lines = body.lines.map((l) => {
      if (l.tax !== "renta" && l.tax !== "iva") throw new CustomError("Tipo de retención: renta o iva", 400);
      const rate = Number(l.rate);
      if (!(rate > 0 && rate <= 100)) throw new CustomError("Porcentaje de retención inválido", 400);
      if (l.tax === "iva" && !VAT_RATES.includes(rate)) throw new CustomError(`Retención de IVA: ${VAT_RATES.join(", ")} %`, 400);
      const base = l.base !== undefined ? cents(l.base, "base") : l.tax === "renta" ? invoice.subtotal0 + invoice.subtotalVat : invoice.vat;
      return { tax: l.tax, rate, base, amount: percentOf(base, rate) };
    });
    const income = sum(lines.filter((l) => l.tax === "renta").map((l) => l.amount));
    const vat = sum(lines.filter((l) => l.tax === "iva").map((l) => l.amount));
    const total = income + vat;
    if (total <= 0) throw new CustomError("La retención debe ser mayor que cero", 400);
    if (total > invoice.balance) {
      throw new CustomError(`La retención (${formatCents(total)}) supera el saldo de la factura (${formatCents(invoice.balance)})`, 409);
    }

    const _id = new Types.ObjectId();
    const source = { module: "cartera", docType: "RETENCION_VENTA", docId: _id, docNumber: voucherNumber };
    const entry = await accounting.postEntry(
      {
        date, type: "RETENCION_VENTA", description: `Retención ${voucherNumber} a factura ${invoice.number} ${invoice.customer?.name}`, source,
        lines: [
          { accountCode: await accounting.mappedAccount("withheldIncomeReceivable", session), debit: income, partyId: invoice.partyId },
          { accountCode: await accounting.mappedAccount("withheldVatReceivable", session), debit: vat, partyId: invoice.partyId },
          { accountCode: await accounting.mappedAccount("customers", session), credit: total, partyId: invoice.partyId },
        ],
      },
      actor,
      session,
    );
    const [doc] = await SalesWithholding.create(
      [{
        _id, invoiceId: invoice._id, invoiceNumber: invoice.number, partyId: invoice.partyId, sellerName: invoice.sellerName,
        date, voucherNumber, authorization: body.authorization ?? "", lines, total, journalEntryId: entry._id, createdBy: actor,
      }],
      { session },
    );
    await addAr(
      { invoiceId: invoice._id, partyId: invoice.partyId, date, kind: "RETENCION", amount: -total, description: `Retención ${voucherNumber}`, source: { docType: "RETENCION_VENTA", docId: _id, docNumber: voucherNumber } },
      session,
    );
    return doc.toObject();
  });
}

export function listWithholdings(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = { status: "vigente" };
  const range = dayRange(query.from, query.to);
  if (range) filter.date = range;
  if (query.invoiceId) filter.invoiceId = oid(query.invoiceId, "factura");
  if (query.partyId) filter.partyId = oid(query.partyId, "cliente");
  return paginate(SalesWithholding, filter, query, ["voucherNumber", "invoiceNumber"]);
}
