import { Party } from "../models/party.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { SalesCreditNote } from "../models/salesCreditNote.model";
import { SalesDebitNote } from "../models/salesDebitNote.model";
import { SalesInvoice } from "../models/salesInvoice.model";
import { SalesWithholding } from "../models/salesWithholding.model";
import { SupplierCreditNote } from "../models/supplierCreditNote.model";
import { Warehouse } from "../models/warehouse.model";
import { sum } from "../utils/money";
import { getSettings } from "./accounting.service";
import { periodBounds } from "./ledgerReports.service";

/**
 * Datos del ATS (Anexo Transaccional Simplificado) de un mes, en centavos y
 * con los nombres de campo de la ficha técnica del SRI. atsXml.service los
 * convierte en el XML; el resumen JSON es este mismo objeto. Lo que nuestros
 * modelos no guardan se reporta con el valor por defecto y queda en `warnings`.
 */

/** Retención de IVA en compras: porcentaje → campo del ATS. */
export const VAT_RET_FIELDS: Record<number, string> = {
  10: "valRetBien10",
  20: "valRetServ20",
  30: "valorRetBienes",
  50: "valRetServ50",
  70: "valorRetServicios",
  100: "valRetServ100",
};

/** En compras el ATS usa su propia tabla: 01 RUC, 02 cédula, 03 pasaporte/exterior. */
const SUPPLIER_ID_TYPES: Record<string, string> = { "04": "01", "05": "02", "06": "03" };
const SALES_DOC_TYPES = { invoice: "18", creditNote: "04", debitNote: "05" } as const;
const FINAL_CONSUMER = "07";

const split = (docNumber: string) => {
  const [establecimiento = "", puntoEmision = "", secuencial = ""] = String(docNumber ?? "").split("-");
  return { establecimiento, puntoEmision, secuencial };
};

function newWarnings() {
  const list: string[] = [];
  return { list, add: (w: string) => void (list.includes(w) || list.push(w)) };
}
type Warn = ReturnType<typeof newWarnings>["add"];

function supplierIdType(party: any, docLabel: string, warn: Warn) {
  const code = SUPPLIER_ID_TYPES[party?.idType ?? "04"];
  if (code) return code;
  warn(`${docLabel}: el proveedor tiene tipo de identificación ${party?.idType} que no vale en compras; se reporta como RUC (01)`);
  return "01";
}

function emptyVatRet() {
  return Object.fromEntries(Object.values(VAT_RET_FIELDS).map((f) => [f, 0])) as Record<string, number>;
}

function purchaseRow(inv: any, party: any, warn: Warn) {
  const label = `Compra ${inv.docNumber} de ${inv.supplierName}`;
  const ret = emptyVatRet();
  for (const w of inv.withholdings.filter((x: any) => x.tax === "iva")) {
    const field = VAT_RET_FIELDS[w.rate];
    if (field) ret[field] += w.amount;
    else warn(`${label}: retención de IVA al ${w.rate}% no tiene casillero en el ATS (10/20/30/50/70/100)`);
  }
  const air = inv.withholdings
    .filter((w: any) => w.tax === "renta")
    .map((w: any) => ({ codRetAir: w.code, baseImpAir: w.base, porcentajeAir: w.rate, valRetAir: w.amount }));
  if (!air.length) warn(`${label}: no tiene retención en la fuente; el SRI espera un código AIR (p. ej. 332 si no aplica)`);
  const autorizacion = inv.authorization || inv.accessKey;
  if (!autorizacion) warn(`${label}: sin número de autorización`);
  let retencion = null;
  if (inv.withholding?.number) {
    const r = split(inv.withholding.number);
    const aut = inv.withholding.authorizationNumber || inv.withholding.accessKey;
    if (inv.withholding.sriStatus !== "autorizado") warn(`${label}: el comprobante de retención ${inv.withholding.number} está "${inv.withholding.sriStatus}" en el SRI`);
    retencion = { estabRetencion1: r.establecimiento, ptoEmiRetencion1: r.puntoEmision, secRetencion1: r.secuencial, autRetencion1: aut, fechaEmiRet1: inv.date };
  }
  return {
    docId: inv._id,
    supplierName: inv.supplierName,
    codSustento: inv.taxSupport,
    tpIdProv: supplierIdType(party, label, warn),
    idProv: inv.supplierRuc,
    tipoComprobante: inv.docType,
    parteRel: "NO",
    fechaRegistro: inv.date,
    ...split(inv.docNumber),
    fechaEmision: inv.date,
    autorizacion,
    baseNoGraIva: 0,
    baseImponible: inv.base0,
    baseImpGrav: inv.baseVat,
    baseImpExe: 0,
    montoIce: 0,
    montoIva: inv.vat,
    ...ret,
    totbasesImpReemb: 0,
    pagoLocExt: "01",
    formaPago: inv.paymentMethod || "20",
    air,
    retencion,
    modificado: null as null | Record<string, string>,
  };
}

/** Nota de crédito del proveedor: va en compras como tipo 04, con la factura que modifica. */
function supplierNoteRow(cn: any, inv: any, party: any, warn: Warn) {
  const label = `NC de compra ${cn.docNumber}`;
  const autorizacion = cn.authorization || cn.accessKey;
  if (!autorizacion) warn(`${label}: sin número de autorización`);
  const m = split(inv.docNumber);
  return {
    ...purchaseRow({ ...inv, ...cn, docType: "04", withholdings: [], withholding: null, paymentMethod: "", authorization: autorizacion, accessKey: "" }, party, () => {}),
    formaPago: "",
    modificado: {
      docModificado: inv.docType,
      estabModificado: m.establecimiento,
      ptoEmiModificado: m.puntoEmision,
      secModificado: m.secuencial,
      autModificado: inv.authorization || inv.accessKey,
    },
  };
}

interface SaleGroup {
  tpIdCliente: string;
  idCliente: string;
  customerName: string;
  parteRelVtas: string | null;
  tipoComprobante: string;
  tipoEmision: "E";
  numeroComprobantes: number;
  baseNoGraIva: number;
  baseImponible: number;
  baseImpGrav: number;
  montoIva: number;
  montoIce: number;
  valorRetIva: number;
  valorRetRenta: number;
  formasDePago: string[];
}

function salesGrouper(warn: Warn) {
  const groups = new Map<string, SaleGroup>();
  const get = (c: any, tipoComprobante: string) => {
    const tp = c?.idType || "04";
    const key = `${tp}|${c?.identification}|${tipoComprobante}`;
    if (!groups.has(key)) {
      if (tp === "06" || tp === "08") warn(`Cliente ${c?.name}: identificación del exterior; el ATS pide tipoCliente y denoCli (no se generan)`);
      groups.set(key, {
        tpIdCliente: tp, idCliente: c?.identification ?? "", customerName: c?.name ?? "",
        parteRelVtas: tp === FINAL_CONSUMER ? null : "NO", tipoComprobante, tipoEmision: "E",
        numeroComprobantes: 0, baseNoGraIva: 0, baseImponible: 0, baseImpGrav: 0, montoIva: 0, montoIce: 0, valorRetIva: 0, valorRetRenta: 0, formasDePago: [],
      });
    }
    return groups.get(key)!;
  };
  const addDoc = (c: any, tipo: string, d: any, paymentMethod?: string) => {
    const g = get(c, tipo);
    g.numeroComprobantes += 1;
    g.baseImponible += d.subtotal0;
    g.baseImpGrav += d.subtotalVat;
    g.montoIva += d.vat;
    if (paymentMethod && !g.formasDePago.includes(paymentMethod)) g.formasDePago.push(paymentMethod);
  };
  return { groups, get, addDoc };
}

/** Comprobante anulado del mes; sin autorización del SRI no se reporta (nunca nació en el SRI). */
function voidedRow(tipoComprobante: string, number: string, autorizacion: string, warn: Warn) {
  if (!autorizacion) {
    warn(`Anulado ${tipoComprobante} ${number}: no tiene autorización del SRI; no se reporta en anulados`);
    return null;
  }
  const s = split(number);
  return { tipoComprobante, establecimiento: s.establecimiento, puntoEmision: s.puntoEmision, secuencialInicio: s.secuencial, secuencialFin: s.secuencial, autorizacion };
}

export async function buildAts(period: string) {
  const { start, end } = periodBounds(period);
  const date = { $gte: start, $lte: end };
  const warnings = newWarnings();
  const warn = warnings.add;
  const noXml = "-xml -lines";

  const [settings, warehouses, purchases, supplierNotes, invoices, creditNotes, debitNotes, withholdings] = await Promise.all([
    getSettings(),
    Warehouse.find({ isActive: true }).lean<any[]>(),
    PurchaseInvoice.find({ date }).select("-withholding.xml -expenseLines -productLines").sort({ date: 1, docNumber: 1 }).lean<any[]>(),
    SupplierCreditNote.find({ date, status: "vigente" }).sort({ date: 1 }).lean<any[]>(),
    SalesInvoice.find({ date }).select(noXml).sort({ date: 1, number: 1 }).lean<any[]>(),
    SalesCreditNote.find({ date }).select(noXml).sort({ date: 1, number: 1 }).lean<any[]>(),
    SalesDebitNote.find({ date }).select("-xml").sort({ date: 1, number: 1 }).lean<any[]>(),
    SalesWithholding.find({ date, status: "vigente" }).sort({ date: 1 }).lean<any[]>(),
  ]);
  const live = <T extends { status: string }>(docs: T[]) => docs.filter((d) => d.status === "vigente");

  // Compras: facturas vigentes del mes y notas de crédito de proveedor (tipo 04).
  const noteInvoices = await PurchaseInvoice.find({ _id: { $in: supplierNotes.map((n) => n.invoiceId) } }).select("-withholding -expenseLines -productLines").lean<any[]>();
  const invoiceBy = new Map(noteInvoices.map((i) => [String(i._id), i]));
  const parties = await Party.find({ _id: { $in: [...purchases.map((p) => p.supplierId), ...supplierNotes.map((n) => n.supplierId)] } }).select("idType").lean<any[]>();
  const partyBy = new Map(parties.map((p) => [String(p._id), p]));
  const compras = [
    ...live(purchases).map((p) => purchaseRow(p, partyBy.get(String(p.supplierId)), warn)),
    ...supplierNotes.map((n) => supplierNoteRow(n, invoiceBy.get(String(n.invoiceId)), partyBy.get(String(n.supplierId)), warn)),
  ];

  // Ventas agrupadas por cliente y tipo de comprobante; las retenciones del mes van al grupo 18 del cliente.
  const sales = salesGrouper(warn);
  const byEstab = new Map<string, number>(warehouses.map((w) => [w.establishment, 0]));
  const addEstab = (estab: string, amount: number) => byEstab.set(estab, (byEstab.get(estab) ?? 0) + amount);
  const customerOf = new Map<string, any>();
  for (const inv of live(invoices)) {
    sales.addDoc(inv.customer, SALES_DOC_TYPES.invoice, inv, inv.paymentMethod || "20");
    addEstab(inv.establishment, inv.subtotal0 + inv.subtotalVat);
  }
  // NC y ND no guardan el cliente: se toma de su factura.
  const related = await SalesInvoice.find({ _id: { $in: [...creditNotes, ...debitNotes, ...withholdings].map((d) => d.invoiceId) } }).select("customer").lean<any[]>();
  for (const r of related) customerOf.set(String(r._id), r.customer);
  for (const dn of live(debitNotes)) {
    sales.addDoc(customerOf.get(String(dn.invoiceId)), SALES_DOC_TYPES.debitNote, dn);
    addEstab(dn.establishment, dn.subtotal0 + dn.subtotalVat);
  }
  for (const cn of live(creditNotes)) {
    sales.addDoc(customerOf.get(String(cn.invoiceId)), SALES_DOC_TYPES.creditNote, cn);
    addEstab(cn.establishment, -(cn.subtotal0 + cn.subtotalVat));
  }
  for (const w of withholdings) {
    const c = customerOf.get(String(w.invoiceId));
    const g = sales.get(c, SALES_DOC_TYPES.invoice);
    if (g.numeroComprobantes === 0) warn(`Retención ${w.voucherNumber} de ${c?.name}: el cliente no tiene facturas en el mes; se reporta con numeroComprobantes 0`);
    g.valorRetRenta += sum(w.lines.filter((l: any) => l.tax === "renta").map((l: any) => l.amount));
    g.valorRetIva += sum(w.lines.filter((l: any) => l.tax === "iva").map((l: any) => l.amount));
  }
  if (compras.length || sales.groups.size) warn("parteRel / parteRelVtas: el sistema no registra partes relacionadas; se reporta NO en todas");
  const ventas = [...sales.groups.values()].sort((a, b) => a.idCliente.localeCompare(b.idCliente) || a.tipoComprobante.localeCompare(b.tipoComprobante));
  const ventasEstablecimiento = [...byEstab].sort(([a], [b]) => a.localeCompare(b)).map(([codEstab, ventasEstab]) => ({ codEstab, ventasEstab, ivaComp: 0 }));

  // Anulados: los que emitimos nosotros (factura, NC, ND y el comprobante de retención de una compra anulada).
  const authorized = (d: any) => (d?.sriStatus === "autorizado" ? d.authorizationNumber || d.accessKey : "");
  const anulados = [
    ...invoices.filter((d) => d.status === "anulado").map((d) => voidedRow("01", d.number, authorized(d), warn)),
    ...creditNotes.filter((d) => d.status === "anulado").map((d) => voidedRow("04", d.number, authorized(d), warn)),
    ...debitNotes.filter((d) => d.status === "anulado").map((d) => voidedRow("05", d.number, authorized(d), warn)),
    ...purchases.filter((p) => p.status === "anulado" && p.withholding?.number).map((p) => voidedRow("07", p.withholding.number, authorized(p.withholding), warn)),
  ].filter((a): a is NonNullable<typeof a> => a !== null);
  if (anulados.length) warn("Anulados: se reportan en el mes de emisión del comprobante; confirma con el contador si van en el mes de la anulación");

  const [anio, mes] = period.split("-");
  if (!settings.company?.ruc) warn("Falta el RUC de la empresa en Configuración");
  const totalVentas = sum(ventasEstablecimiento.map((v) => v.ventasEstab));
  const sign = (tipo: string) => (tipo === "04" ? -1 : 1);
  return {
    period,
    informante: {
      TipoIDInformante: "R",
      IdInformante: settings.company?.ruc ?? "",
      razonSocial: settings.company?.legalName ?? "",
      Anio: anio,
      Mes: mes,
      numEstabRuc: String(byEstab.size).padStart(3, "0"),
      totalVentas,
      codigoOperativo: "IVA",
    },
    compras,
    ventas,
    ventasEstablecimiento,
    anulados,
    totals: {
      compras: compras.length,
      baseImponibleCompras: sum(compras.map((c) => sign(c.tipoComprobante) * c.baseImponible)),
      baseImpGravCompras: sum(compras.map((c) => sign(c.tipoComprobante) * c.baseImpGrav)),
      ivaCompras: sum(compras.map((c) => sign(c.tipoComprobante) * c.montoIva)),
      retRentaEmitidas: sum(compras.flatMap((c) => c.air.map((a: any) => a.valRetAir))),
      retIvaEmitidas: sum(compras.flatMap((c) => Object.values(VAT_RET_FIELDS).map((f) => (c as any)[f] as number))),
      ventasNetas: totalVentas,
      ivaVentas: sum(ventas.map((v) => sign(v.tipoComprobante) * v.montoIva)),
      retRentaRecibidas: sum(ventas.map((v) => v.valorRetRenta)),
      retIvaRecibidas: sum(ventas.map((v) => v.valorRetIva)),
      anulados: anulados.length,
    },
    warnings: warnings.list,
  };
}

export type AtsData = Awaited<ReturnType<typeof buildAts>>;
