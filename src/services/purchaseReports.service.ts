import { CustomError } from "../errors/customError.error";
import { Account } from "../models/account.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { dayRange } from "../utils/dates";
import { sum } from "../utils/money";

/**
 * Reportes de compras e impuestos de Compras: por proveedor, por cuenta
 * contable, por tipo de sustento (tarifa 0 y 15 separadas) y retenciones
 * emitidas por código, por sustento y por número. Siempre ?from=&to=.
 */
const AMOUNT_FIELDS = ["base0", "baseVat", "vat", "total"] as const;

async function invoicesIn(query: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const range = dayRange(query.from, query.to);
  if (!range) throw new CustomError("Indica el rango de fechas (from, to)", 400);
  const filter: Record<string, unknown> = { status: "vigente", date: range, ...extra };
  if (query.supplierId) filter.supplierId = query.supplierId;
  if (query.docType) filter.docType = query.docType;
  return PurchaseInvoice.find(filter).select("-withholding.xml").sort({ date: 1, docNumber: 1 }).lean<any[]>();
}

const totalsOf = (rows: any[], fields: readonly string[] = AMOUNT_FIELDS) =>
  Object.fromEntries(fields.map((f) => [f, sum(rows.map((r) => r[f] ?? 0))]));

/** Agrupa filas por una clave y suma los campos de montos de cada grupo. */
function groupBy(rows: any[], key: (r: any) => string, label: (r: any) => Record<string, unknown>, fields: readonly string[]): any[] {
  const groups = new Map<string, any[]>();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  return [...groups.values()].map((items) => ({ ...label(items[0]), count: items.length, ...totalsOf(items, fields), items }));
}

const invoiceRow = (i: any) => ({
  _id: i._id,
  docType: i.docType,
  docNumber: i.docNumber,
  authorization: i.authorization,
  electronic: Boolean(i.accessKey),
  date: i.date,
  supplierId: i.supplierId,
  supplierName: i.supplierName,
  supplierRuc: i.supplierRuc,
  taxSupport: i.taxSupport,
  base0: i.base0,
  baseVat: i.baseVat,
  vat: i.vat,
  total: i.total,
});

export async function purchasesBySupplier(query: Record<string, unknown>) {
  const rows = (await invoicesIn(query)).map(invoiceRow);
  const items = groupBy(rows, (r) => String(r.supplierId), (r) => ({ supplierId: r.supplierId, name: r.supplierName, identification: r.supplierRuc }), AMOUNT_FIELDS);
  return { items, totals: totalsOf(rows), total: rows.length };
}

/** Cada línea de gasto o de mercadería suma a su cuenta (gasto o inventario del grupo). */
export async function purchasesByAccount(query: Record<string, unknown>) {
  const invoices = await invoicesIn(query);
  const rows = invoices.flatMap((i) => [
    ...i.expenseLines.map((l: any) => ({ accountCode: l.accountCode, base0: l.base0, baseVat: l.baseVat, costCenter: l.costCenter, docNumber: i.docNumber, date: i.date, supplierName: i.supplierName })),
    ...i.productLines.map((l: any) => ({ accountCode: l.accountCode, base0: l.vatRate ? 0 : l.subtotal, baseVat: l.vatRate ? l.subtotal : 0, costCenter: "", docNumber: i.docNumber, date: i.date, supplierName: i.supplierName })),
  ]);
  const accounts = await Account.find({ code: { $in: [...new Set(rows.map((r) => r.accountCode))] } }).select("code name").lean<any[]>();
  const nameBy = new Map(accounts.map((a) => [a.code, a.name]));
  const items = groupBy(rows, (r) => r.accountCode, (r) => ({ accountCode: r.accountCode, accountName: nameBy.get(r.accountCode) ?? "" }), ["base0", "baseVat"]);
  items.sort((a: any, b: any) => a.accountCode.localeCompare(b.accountCode));
  return { items, totals: totalsOf(rows, ["base0", "baseVat"]), total: rows.length };
}

/** "Compras por tipo de sustento": base 0 y base 15 separadas, con total de registros. */
export async function purchasesByTaxSupport(query: Record<string, unknown>) {
  const rows = (await invoicesIn(query)).map(invoiceRow);
  const items = groupBy(rows, (r) => r.taxSupport, (r) => ({ taxSupport: r.taxSupport }), AMOUNT_FIELDS);
  items.sort((a: any, b: any) => a.taxSupport.localeCompare(b.taxSupport));
  return { items, totals: totalsOf(rows), total: rows.length };
}

/** Retenciones emitidas. ?by=code|support|number */
export async function withholdingsReport(query: Record<string, unknown>) {
  const invoices = await invoicesIn(query, { withholding: { $ne: null } });
  const rows = invoices.flatMap((i) =>
    i.withholdings.map((w: any) => ({
      ...invoiceRow(i),
      withholdingNumber: i.withholding.number,
      withholdingAccessKey: i.withholding.accessKey,
      sriStatus: i.withholding.sriStatus,
      tax: w.tax,
      code: w.code,
      description: w.description,
      base: w.base,
      rate: w.rate,
      amount: w.amount,
    })),
  );
  const by = String(query.by ?? "code");
  const fields = ["base", "amount"] as const;
  let items: any[];
  if (by === "number") {
    items = rows.sort((a, b) => a.withholdingNumber.localeCompare(b.withholdingNumber));
  } else if (by === "support") {
    items = groupBy(rows, (r) => r.taxSupport, (r) => ({ taxSupport: r.taxSupport }), fields).sort((a, b) => a.taxSupport.localeCompare(b.taxSupport));
  } else if (by === "code") {
    items = groupBy(rows, (r) => `${r.tax}-${r.code}`, (r) => ({ tax: r.tax, code: r.code, description: r.description }), fields)
      .sort((a, b) => b.tax.localeCompare(a.tax) || a.code.localeCompare(b.code));
  } else throw new CustomError("Agrupa por code, support o number", 400);
  return {
    by,
    items,
    totals: { renta: sum(rows.filter((r) => r.tax === "renta").map((r) => r.amount)), iva: sum(rows.filter((r) => r.tax === "iva").map((r) => r.amount)) },
    total: rows.length,
  };
}
