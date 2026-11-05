import { ClientSession, Model, Types } from "mongoose";
import { ArMovement } from "../models/arMovement.model";
import { BankMovement } from "../models/bankMovement.model";
import { BankTransaction } from "../models/bankTransaction.model";
import { CustomerReceipt } from "../models/customerReceipt.model";
import { InventoryMovement } from "../models/inventoryMovement.model";
import { InventoryTransaction } from "../models/inventoryTransaction.model";
import { JournalEntry } from "../models/journalEntry.model";
import { PayableTransaction } from "../models/payableTransaction.model";
import { PaymentApproval } from "../models/paymentApproval.model";
import { Product } from "../models/product.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { SalesCreditNote } from "../models/salesCreditNote.model";
import { SalesDebitNote } from "../models/salesDebitNote.model";
import { SalesInvoice } from "../models/salesInvoice.model";
import { SalesProforma } from "../models/salesProforma.model";
import { SalesWithholding } from "../models/salesWithholding.model";
import { SupplierCreditNote } from "../models/supplierCreditNote.model";

/**
 * ¿Algún documento usa estos terceros, productos o saldos? Lo usan quitar una
 * importación y quitar los datos de ejemplo: si algo los usa, no se borran y
 * se dice qué documento lo impide.
 */
interface Check {
  model: Model<any>;
  label: string;
  field: string;
  filter: Record<string, unknown>;
}

type Ids = Types.ObjectId[];
/** `docId` de la propia importación: sus movimientos no cuentan como uso. */
const notOwn = (path: string, batchId?: Types.ObjectId | null) => (batchId ? { [path]: { $ne: batchId } } : {});

export function partyChecks(ids: Ids, opts: { batchId?: Types.ObjectId | null; ignoreProducts?: Ids } = {}): Check[] {
  const $in = ids;
  const own = opts.batchId;
  return [
    { model: SalesInvoice, label: "Factura de venta", field: "number", filter: { partyId: { $in }, ...notOwn("importBatchId", own) } },
    { model: SalesProforma, label: "Proforma", field: "number", filter: { partyId: { $in } } },
    { model: SalesCreditNote, label: "Nota de crédito", field: "number", filter: { partyId: { $in } } },
    { model: SalesDebitNote, label: "Nota de débito", field: "number", filter: { partyId: { $in } } },
    { model: SalesWithholding, label: "Retención recibida", field: "voucherNumber", filter: { partyId: { $in } } },
    { model: CustomerReceipt, label: "Cobro", field: "number", filter: { partyId: { $in } } },
    { model: PurchaseInvoice, label: "Factura de proveedor", field: "docNumber", filter: { supplierId: { $in } } },
    { model: SupplierCreditNote, label: "Nota de crédito de proveedor", field: "docNumber", filter: { supplierId: { $in } } },
    { model: PayableTransaction, label: "Pago a proveedor", field: "number", filter: { partyId: { $in } } },
    { model: PaymentApproval, label: "Aprobación de pago", field: "number", filter: { beneficiaryId: { $in } } },
    { model: BankTransaction, label: "Transacción bancaria", field: "number", filter: { partyId: { $in } } },
    { model: BankMovement, label: "Movimiento bancario", field: "description", filter: { partyId: { $in } } },
    { model: InventoryTransaction, label: "Transacción de inventario", field: "number", filter: { partyId: { $in } } },
    { model: InventoryMovement, label: "Movimiento de inventario", field: "source.docNumber", filter: { partyId: { $in }, ...notOwn("source.docId", own) } },
    { model: JournalEntry, label: "Asiento", field: "number", filter: { "lines.partyId": { $in }, ...notOwn("source.docId", own) } },
    { model: ArMovement, label: "Movimiento de cartera", field: "source.docNumber", filter: { partyId: { $in }, ...notOwn("source.docId", own) } },
    {
      model: Product, label: "Producto (proveedor)", field: "code",
      filter: { supplierId: { $in }, ...notOwn("importBatchId", own), ...(opts.ignoreProducts?.length ? { _id: { $nin: opts.ignoreProducts } } : {}) },
    },
  ];
}

export function productChecks(ids: Ids, batchId?: Types.ObjectId | null): Check[] {
  const $in = ids;
  return [
    { model: InventoryMovement, label: "Movimiento de inventario", field: "source.docNumber", filter: { productId: { $in }, ...notOwn("source.docId", batchId) } },
    { model: InventoryTransaction, label: "Transacción de inventario", field: "number", filter: { "lines.productId": { $in } } },
    { model: SalesInvoice, label: "Factura de venta", field: "number", filter: { "lines.productId": { $in } } },
    { model: SalesProforma, label: "Proforma", field: "number", filter: { "lines.productId": { $in } } },
    { model: SalesCreditNote, label: "Nota de crédito", field: "number", filter: { "lines.productId": { $in } } },
    { model: PurchaseInvoice, label: "Factura de proveedor", field: "docNumber", filter: { "productLines.productId": { $in } } },
    { model: SupplierCreditNote, label: "Nota de crédito de proveedor", field: "docNumber", filter: { "productLines.productId": { $in } } },
  ];
}

/** Cobros, retenciones o notas aplicados a saldos importados (lo que no sea la propia carga). */
export function receivableChecks(invoiceIds: Ids, batchId: Types.ObjectId): Check[] {
  return [{ model: ArMovement, label: "Cobro, retención o nota aplicada a un saldo importado", field: "source.docNumber", filter: { invoiceId: { $in: invoiceIds }, "source.docId": { $ne: batchId } } }];
}

/** Movimientos de stock de otros documentos, después de la importación, en productos que ya existían. */
export function stockAfterChecks(productIds: Ids, since: Date, batchId: Types.ObjectId): Check[] {
  return [{ model: InventoryMovement, label: "Movimiento de inventario posterior", field: "source.docNumber", filter: { productId: { $in: productIds }, createdAt: { $gt: since }, "source.docId": { $ne: batchId } } }];
}

const get = (doc: any, path: string) => path.split(".").reduce((o, k) => o?.[k], doc);

/** "Cobro COB-000000001, COB-000000002 (y 3 más)" por cada tipo de documento que usa los datos. */
export async function findUsages(checks: Check[], session?: ClientSession): Promise<string[]> {
  const out: string[] = [];
  for (const c of checks) {
    if (Object.values(c.filter).some((v: any) => Array.isArray(v?.$in) && v.$in.length === 0)) continue;
    const [docs, total] = await Promise.all([
      c.model.find(c.filter).session(session ?? null).select(c.field).limit(5).lean<any[]>(),
      c.model.countDocuments(c.filter).session(session ?? null),
    ]);
    if (!total) continue;
    const names = [...new Set(docs.map((d) => String(get(d, c.field) ?? "").trim()).filter(Boolean))].join(", ");
    out.push(`${c.label}${names ? ` ${names}` : ""}${total > docs.length ? ` (y ${total - docs.length} más)` : ""}`);
  }
  return out;
}
