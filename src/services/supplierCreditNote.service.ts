import { Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { Product } from "../models/product.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { SupplierCreditNote } from "../models/supplierCreditNote.model";
import { cents, formatCents, percentOf, roundQty, sum } from "../utils/money";
import { parseDay } from "../utils/dates";
import * as accounting from "./accounting.service";
import type { Actor, EntryLineInput } from "./accounting.service";
import * as inventoryCore from "./inventoryCore.service";
import { applyToInvoices } from "./payables.service";
import { normalizeDocNumber, VAT_RATE } from "./purchaseInvoiceInput.service";

/**
 * Nota de crédito del proveedor aplicada a una factura (faltantes: llegaron
 * 97 lb de 100). Asiento NC_COMPRA: Debe Proveedores / Haber gasto o
 * inventario + IVA pagado. Con productos, el stock sale al costo promedio y
 * la diferencia contra el valor de la NC va a la cuenta de ajuste de inventario.
 */
export async function createCreditNote(body: any, actor: Actor) {
  const invoice = await PurchaseInvoice.findById(body?.invoiceId).lean<any>();
  if (!invoice || invoice.status !== "vigente") throw new CustomError("Factura de proveedor no encontrada o anulada", 404);
  const date = parseDay(body?.date);
  if (date < invoice.date) throw new CustomError("La nota de crédito no puede ser anterior a la factura", 400);

  const lines = (Array.isArray(body?.lines) ? body.lines : []).map((l: any) => {
    if (!l?.accountCode) throw new CustomError("Cada línea de la nota de crédito necesita su cuenta", 400);
    return { accountCode: String(l.accountCode), base0: cents(l.base0 ?? 0, "base 0"), baseVat: cents(l.baseVat ?? 0, "base IVA"), description: String(l.description ?? "") };
  });
  const productLines: { productId: Types.ObjectId; qty: number; subtotal: number; vatRate: number }[] = [];
  for (const l of Array.isArray(body?.productLines) ? body.productLines : []) {
    const line = invoice.productLines.find((p: any) => String(p.productId) === String(l?.productId));
    if (!line) throw new CustomError("El producto de la nota de crédito no está en la factura", 400);
    const qty = roundQty(Number(l.qty));
    if (!(qty > 0 && qty <= line.qty)) throw new CustomError("Cantidad inválida en la nota de crédito", 400);
    productLines.push({ productId: line.productId, qty, subtotal: cents(l.subtotal, "subtotal"), vatRate: line.vatRate });
  }
  if (!lines.length && !productLines.length) throw new CustomError("La nota de crédito necesita líneas", 400);

  const base0 = sum(lines.map((l: any) => l.base0)) + sum(productLines.filter((l) => !l.vatRate).map((l) => l.subtotal));
  const baseVat = sum(lines.map((l: any) => l.baseVat)) + sum(productLines.filter((l) => l.vatRate).map((l) => l.subtotal));
  const vat = body?.vat !== undefined && body?.vat !== null ? cents(body.vat, "IVA") : percentOf(baseVat, VAT_RATE);
  const total = base0 + baseVat + vat;
  if (total <= 0) throw new CustomError("La nota de crédito no tiene valor", 400);
  if (total > invoice.balance - invoice.approved) {
    throw new CustomError(`La factura solo tiene ${formatCents(invoice.balance - invoice.approved)} libres para la nota de crédito`, 409);
  }
  const docNumber = normalizeDocNumber(body?.series, body?.number);

  return runInTransaction(async (session) => {
    if (await SupplierCreditNote.exists({ supplierId: invoice.supplierId, docNumber, status: "vigente" }).session(session)) {
      throw new CustomError(`La nota de crédito ${docNumber} ya está ingresada`, 409);
    }
    const _id = new Types.ObjectId();
    const source = { module: "compras", docType: "NC_COMPRA", docId: _id, docNumber };
    const entryLines: EntryLineInput[] = [
      { accountCode: await accounting.mappedAccount("suppliers", session), debit: total, partyId: invoice.supplierId },
      ...lines.map((l: any) => ({ accountCode: l.accountCode, credit: l.base0 + l.baseVat, description: l.description })),
      { accountCode: await accounting.mappedAccount("vatPurchases", session), credit: vat },
    ];

    if (productLines.length) {
      const applied = await inventoryCore.applyMovement(
        {
          warehouseId: invoice.warehouseId,
          date,
          type: "NOTA_CREDITO_COMPRA",
          partyId: invoice.supplierId,
          source,
          lines: productLines.map((l) => ({ productId: l.productId, qty: l.qty })),
        },
        actor,
        session,
      );
      const products = await Product.find({ _id: { $in: productLines.map((l) => l.productId) } }).populate("groupId").session(session).lean<any[]>();
      const inventoryAccount = new Map(products.map((p) => [String(p.groupId._id), p.groupId.accounts.inventory]));
      for (const [groupId, cost] of inventoryCore.totalsByGroup(applied)) {
        entryLines.push({ accountCode: inventoryAccount.get(groupId)!, credit: cost });
      }
      const diff = sum(productLines.map((l) => l.subtotal)) - sum(applied.map((a) => a.totalCost));
      const adjustment = await accounting.mappedAccount("inventoryAdjustment", session);
      if (diff > 0) entryLines.push({ accountCode: adjustment, credit: diff, description: "Diferencia NC vs costo promedio" });
      if (diff < 0) entryLines.push({ accountCode: adjustment, debit: -diff, description: "Diferencia NC vs costo promedio" });
    }

    const entry = await accounting.postEntry(
      { date, type: "NC_COMPRA", description: `NC ${docNumber} de ${invoice.supplierName} a la factura ${invoice.docNumber}`, source, lines: entryLines },
      actor,
      session,
    );
    await applyToInvoices([{ invoiceId: invoice._id, amount: total }], "nc", _id, date, session);
    const [doc] = await SupplierCreditNote.create(
      [
        {
          _id,
          supplierId: invoice.supplierId,
          invoiceId: invoice._id,
          docNumber,
          date,
          authorization: String(body?.authorization ?? ""),
          accessKey: String(body?.accessKey ?? ""),
          reason: String(body?.reason ?? ""),
          lines,
          productLines: productLines.map(({ productId, qty, subtotal }) => ({ productId, qty, subtotal })),
          warehouseId: productLines.length ? invoice.warehouseId : null,
          base0,
          baseVat,
          vat,
          total,
          journalEntryId: entry._id,
          createdBy: actor,
        },
      ],
      { session },
    );
    return doc.toObject();
  });
}

export async function listCreditNotes(query: Record<string, unknown>) {
  const filter: Record<string, unknown> = {};
  if (query.supplierId) filter.supplierId = query.supplierId;
  if (query.invoiceId) filter.invoiceId = query.invoiceId;
  const items = await SupplierCreditNote.find(filter).sort({ date: -1 }).limit(500).lean();
  return { items, total: items.length, page: 1, pages: 1 };
}
