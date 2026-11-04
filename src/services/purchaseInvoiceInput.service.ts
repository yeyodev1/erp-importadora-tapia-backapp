import { Types } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { Party } from "../models/party.model";
import { Product } from "../models/product.model";
import { PURCHASE_DOC_TYPES, IWithholdingLine } from "../models/purchaseInvoice.model";
import { Warehouse } from "../models/warehouse.model";
import { WithholdingCode } from "../models/withholdingCode.model";
import { cents, formatCents, percentOf, roundQty, sum } from "../utils/money";
import { parseDay } from "../utils/dates";
import { mappedAccount } from "./accounting.service";

/**
 * Convierte el cuerpo de la API en una factura de proveedor lista para grabar:
 * valida líneas, calcula bases, IVA, retenciones y neto a pagar. No graba nada.
 */
export const VAT_RATE = 15;

/** "001-002-12345", "001002" + "12345" → "001-002-000012345". */
export function normalizeDocNumber(series: unknown, number: unknown): string {
  const full = `${series ?? ""}${number ? `-${number}` : ""}`;
  const m = /^(\d{3})-?(\d{3})-?(\d{1,9})$/.exec(full.replace(/\s/g, ""));
  if (!m) throw new CustomError("Serie y número inválidos (ej. 001-002 y 000012345)", 400);
  return `${m[1]}-${m[2]}-${m[3].padStart(9, "0")}`;
}

const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86400000);

async function resolveWithholdings(raw: unknown, base0: number, baseVat: number, vat: number): Promise<IWithholdingLine[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new CustomError("Las retenciones deben ser una lista", 400);
  const out: IWithholdingLine[] = [];
  for (const w of raw) {
    if (!Types.ObjectId.isValid(String(w?.codeId))) throw new CustomError("Código de retención inválido", 400);
    const code = await WithholdingCode.findById(w.codeId).lean<any>();
    if (!code || !code.isActive) throw new CustomError("Código de retención no encontrado o inactivo", 404);
    const base = cents(w.base, `base de la retención ${code.code}`);
    const rate = w.rate === undefined || w.rate === null ? code.rate : Number(w.rate);
    if (!(rate >= 0 && rate <= 100)) throw new CustomError(`Porcentaje inválido en la retención ${code.code}`, 400);
    const amount = percentOf(base, rate);
    if (w.amount !== undefined && w.amount !== null && cents(w.amount, "valor retenido") !== amount) {
      throw new CustomError(`La retención ${code.code}: ${rate}% de ${formatCents(base)} es ${formatCents(amount)}`, 400);
    }
    const accountCode =
      code.accountCode || (await mappedAccount(code.tax === "renta" ? "incomeWithholdingPayable" : "vatWithholdingPayable"));
    out.push({ codeId: code._id, tax: code.tax, code: code.code, description: code.description, base, rate, amount, accountCode });
  }
  const rentaBase = sum(out.filter((w) => w.tax === "renta").map((w) => w.base));
  const ivaBase = sum(out.filter((w) => w.tax === "iva").map((w) => w.base));
  if (rentaBase > base0 + baseVat) throw new CustomError("Las bases de retención en la fuente superan el subtotal", 400);
  if (ivaBase > vat) throw new CustomError("Las bases de retención de IVA superan el IVA de la factura", 400);
  return out;
}

export async function buildInvoice(body: any) {
  const supplier = await Party.findById(body?.supplierId).lean<any>();
  if (!supplier) throw new CustomError("Proveedor no encontrado", 404);
  if (!supplier.isSupplier && !supplier.isEmployee) throw new CustomError(`${supplier.name} no está marcado como proveedor`, 400);

  const docType = String(body?.docType ?? "01");
  if (!PURCHASE_DOC_TYPES[docType]) throw new CustomError("Tipo de comprobante inválido (01, 02 o 03)", 400);
  const date = parseDay(body?.date);
  if (body?.accessKey && !/^\d{49}$/.test(String(body.accessKey))) throw new CustomError("La clave de acceso debe tener 49 dígitos", 400);
  const creditDays = Math.max(0, Math.trunc(Number(body?.creditDays ?? supplier.supplier?.creditDays ?? 0)) || 0);

  const expenseLines = (Array.isArray(body?.expenseLines) ? body.expenseLines : []).map((l: any) => {
    if (!l?.accountCode) throw new CustomError("Cada línea de gasto necesita su cuenta contable", 400);
    const line = {
      accountCode: String(l.accountCode),
      base0: cents(l.base0 ?? 0, "base 0"),
      baseVat: cents(l.baseVat ?? 0, "base IVA"),
      description: String(l.description ?? ""),
      costCenter: String(l.costCenter ?? ""),
    };
    if (line.base0 + line.baseVat === 0) throw new CustomError("Hay una línea de gasto sin valor", 400);
    return line;
  });

  const rawProducts = Array.isArray(body?.productLines) ? body.productLines : [];
  let warehouseId: Types.ObjectId | null = null;
  if (rawProducts.length) {
    const wh = await Warehouse.findById(body?.warehouseId).lean<any>();
    if (!wh) throw new CustomError("Indica la bodega donde ingresa la mercadería", 400);
    warehouseId = wh._id;
  }
  const productLines = [];
  for (const l of rawProducts) {
    const product = await Product.findById(l?.productId).populate("groupId").lean<any>();
    if (!product) throw new CustomError("Producto no encontrado", 404);
    const qty = roundQty(Number(l.qty));
    if (!(qty > 0)) throw new CustomError(`Cantidad inválida para ${product.name}`, 400);
    const subtotal = cents(l.subtotal, `subtotal de ${product.name}`);
    const vatRate = Number(l.vatRate ?? product.vatRate ?? 0);
    if (![0, VAT_RATE].includes(vatRate)) throw new CustomError(`IVA inválido para ${product.name}`, 400);
    productLines.push({
      productId: product._id,
      qty,
      subtotal,
      vatRate,
      accountCode: product.groupId.accounts.inventory,
      description: String(l.description ?? product.name),
    });
  }
  if (!expenseLines.length && !productLines.length) throw new CustomError("La factura necesita líneas de gasto o de productos", 400);

  const base0 = sum(expenseLines.map((l: any) => l.base0)) + sum(productLines.filter((l) => !l.vatRate).map((l) => l.subtotal));
  const baseVat = sum(expenseLines.map((l: any) => l.baseVat)) + sum(productLines.filter((l) => l.vatRate).map((l) => l.subtotal));
  let vat = percentOf(baseVat, VAT_RATE);
  // El XML trae el IVA redondeado por línea: se acepta el del proveedor si difiere en centavos de redondeo.
  if (body?.vat !== undefined && body?.vat !== null) {
    const given = cents(body.vat, "IVA");
    const tolerance = Math.max(2, expenseLines.length + productLines.length);
    if (Math.abs(given - vat) > tolerance) throw new CustomError(`El IVA debería ser ${formatCents(vat)}`, 400);
    vat = given;
  }
  const total = base0 + baseVat + vat;
  const withholdings = await resolveWithholdings(body?.withholdings, base0, baseVat, vat);
  const withholdingTotal = sum(withholdings.map((w) => w.amount));
  const payable = total - withholdingTotal;
  if (payable < 0) throw new CustomError("Las retenciones superan el total de la factura", 400);

  return {
    supplier,
    data: {
      supplierId: supplier._id,
      supplierRuc: supplier.identification,
      supplierName: supplier.name,
      docType,
      docNumber: normalizeDocNumber(body?.series, body?.number),
      date,
      dueDate: addDays(date, creditDays),
      expiryDate: body?.expiryDate ? parseDay(body.expiryDate, "fecha de caducidad") : null,
      authorization: String(body?.authorization ?? body?.accessKey ?? ""),
      accessKey: String(body?.accessKey ?? ""),
      creditDays,
      taxSupport: String(body?.taxSupport ?? "01"),
      goodsOrServices: body?.goodsOrServices === "servicio" ? "servicio" : "bien",
      paymentMethod: String(body?.paymentMethod ?? "20"),
      description: String(body?.description ?? ""),
      expenseLines,
      productLines,
      warehouseId,
      vatRate: VAT_RATE,
      base0,
      baseVat,
      vat,
      total,
      withholdings,
      withholdingTotal,
      payable,
      balance: payable,
      approved: 0,
    },
  };
}
