import { JournalEntry } from "../models/journalEntry.model";
import { ProductGroup } from "../models/productGroup.model";
import { WithholdingCode } from "../models/withholdingCode.model";
import { sum } from "../utils/money";
import { mappedAccount } from "./accounting.service";
import { buildAts, VAT_RET_FIELDS } from "./ats.service";
import { periodBounds } from "./ledgerReports.service";

/**
 * Cuadre mensual de impuestos: lo que cruzan los auditores mes a mes. Cada
 * concepto compara lo que dicen los documentos del ATS contra el movimiento
 * del mes en sus cuentas del mapa contable.
 * shortcut: los pagos (PAGO, BANCO) y el cierre anual no cuentan, porque pagar al SRI no cambia lo
 * declarado; una liquidación de IVA hecha con asiento de diario sí sale como diferencia (se ve en `byEntryType`).
 */
const EXCLUDED_TYPES = ["PAGO", "BANCO", "CIERRE"];

/** "deudor": saldo = debe − haber (activos); "acreedor": haber − debe (pasivos e ingresos). */
type Nature = "deudor" | "acreedor";

async function movementsByType(accounts: string[], start: Date, end: Date) {
  const rows = await JournalEntry.aggregate([
    { $match: { date: { $gte: start, $lte: end }, "lines.accountCode": { $in: accounts } } },
    { $unwind: "$lines" },
    { $match: { "lines.accountCode": { $in: accounts } } },
    { $group: { _id: { account: "$lines.accountCode", type: "$type" }, debit: { $sum: "$lines.debit" }, credit: { $sum: "$lines.credit" } } },
  ]);
  return rows.map((r) => ({ account: r._id.account as string, type: r._id.type as string, debit: r.debit as number, credit: r.credit as number }));
}

export async function monthlyReconciliation(period: string) {
  const { start, end } = periodBounds(period);
  const [ats, groups, codes] = await Promise.all([
    buildAts(period),
    ProductGroup.find().select("accounts.sales").lean<any[]>(),
    WithholdingCode.find({ accountCode: { $ne: "" } }).select("tax accountCode").lean<any[]>(),
  ]);
  const customCodes = (tax: string) => codes.filter((c) => c.tax === tax).map((c) => c.accountCode as string);
  const concepts: { key: string; label: string; nature: Nature; accounts: string[]; documents: number }[] = [
    { key: "ventasNetas", label: "Ventas netas (facturas + ND − NC, sin IVA)", nature: "acreedor", accounts: [...new Set(groups.map((g) => g.accounts?.sales).filter(Boolean))], documents: ats.totals.ventasNetas },
    { key: "ivaVentas", label: "IVA en ventas", nature: "acreedor", accounts: [await mappedAccount("vatSales")], documents: ats.totals.ivaVentas },
    { key: "ivaCompras", label: "IVA en compras", nature: "deudor", accounts: [await mappedAccount("vatPurchases")], documents: ats.totals.ivaCompras },
    { key: "retRentaRecibidas", label: "Retenciones en la fuente que nos hicieron", nature: "deudor", accounts: [await mappedAccount("withheldIncomeReceivable")], documents: ats.totals.retRentaRecibidas },
    { key: "retIvaRecibidas", label: "Retenciones de IVA que nos hicieron", nature: "deudor", accounts: [await mappedAccount("withheldVatReceivable")], documents: ats.totals.retIvaRecibidas },
    { key: "retRentaEmitidas", label: "Retenciones en la fuente emitidas", nature: "acreedor", accounts: [...new Set([await mappedAccount("incomeWithholdingPayable"), ...customCodes("renta")])], documents: ats.totals.retRentaEmitidas },
    { key: "retIvaEmitidas", label: "Retenciones de IVA emitidas", nature: "acreedor", accounts: [...new Set([await mappedAccount("vatWithholdingPayable"), ...customCodes("iva")])], documents: ats.totals.retIvaEmitidas },
  ];
  const moves = await movementsByType([...new Set(concepts.flatMap((c) => c.accounts))], start, end);

  const items = concepts.map((c) => {
    const signed = (m: { debit: number; credit: number }) => (c.nature === "deudor" ? m.debit - m.credit : m.credit - m.debit);
    const mine = moves.filter((m) => c.accounts.includes(m.account));
    const byEntryType: Record<string, number> = {};
    for (const m of mine) byEntryType[m.type] = (byEntryType[m.type] ?? 0) + signed(m);
    const valorContable = sum(mine.filter((m) => !EXCLUDED_TYPES.includes(m.type)).map(signed));
    const diferencia = c.documents - valorContable;
    return { concepto: c.key, label: c.label, cuentas: c.accounts, valorDocumentos: c.documents, valorContable, diferencia, cuadra: diferencia === 0, byEntryType };
  });

  return {
    period,
    signConvention: "positivo = saldo natural de la cuenta (deudor en activos, acreedor en pasivos e ingresos)",
    excludedEntryTypes: EXCLUDED_TYPES,
    items,
    cuadra: items.every((i) => i.cuadra),
    form104: form104(ats),
    warnings: ats.warnings,
  };
}

/** Sugerencia de casilleros del formulario 104 a partir del ATS. Referencial: la declaración la arma el contador. */
function form104(ats: Awaited<ReturnType<typeof buildAts>>) {
  const pick = (tipo: string, f: (v: any) => number) => sum(ats.ventas.filter((v) => v.tipoComprobante === tipo).map(f));
  const grossVat = pick("18", (v) => v.baseImpGrav) + pick("05", (v) => v.baseImpGrav);
  const gross0 = pick("18", (v) => v.baseImponible) + pick("05", (v) => v.baseImponible);
  const ivaGross = pick("18", (v) => v.montoIva) + pick("05", (v) => v.montoIva);
  const purchases = ats.compras.filter((c) => c.tipoComprobante !== "04");
  const notes = ats.compras.filter((c) => c.tipoComprobante === "04");
  const buy = (rows: typeof purchases, f: (c: any) => number) => sum(rows.map(f));
  const withheld = Object.fromEntries(
    Object.entries(VAT_RET_FIELDS).map(([rate, field]) => [rate, buy(purchases, (c) => c[field])]),
  );
  return {
    referencial: true,
    nota: "Sugerencia a partir del ATS; revisa los casilleros vigentes del formulario 104 antes de declarar. Montos en centavos.",
    casilleros: [
      { casillero: "401", label: "Ventas locales gravadas tarifa diferente de 0 (bruto)", valor: grossVat },
      { casillero: "411", label: "Ventas locales gravadas tarifa diferente de 0 (neto de NC)", valor: grossVat - pick("04", (v) => v.baseImpGrav) },
      { casillero: "421", label: "IVA generado", valor: ivaGross - pick("04", (v) => v.montoIva) },
      { casillero: "403", label: "Ventas locales tarifa 0 (bruto)", valor: gross0 },
      { casillero: "413", label: "Ventas locales tarifa 0 (neto de NC)", valor: gross0 - pick("04", (v) => v.baseImponible) },
      { casillero: "500", label: "Adquisiciones gravadas tarifa diferente de 0 (bruto)", valor: buy(purchases, (c) => c.baseImpGrav) },
      { casillero: "510", label: "Adquisiciones gravadas tarifa diferente de 0 (neto de NC)", valor: buy(purchases, (c) => c.baseImpGrav) - buy(notes, (c) => c.baseImpGrav) },
      { casillero: "520", label: "IVA en compras", valor: buy(purchases, (c) => c.montoIva) - buy(notes, (c) => c.montoIva) },
      { casillero: "507", label: "Adquisiciones tarifa 0 (bruto)", valor: buy(purchases, (c) => c.baseImponible) },
      { casillero: "517", label: "Adquisiciones tarifa 0 (neto de NC)", valor: buy(purchases, (c) => c.baseImponible) - buy(notes, (c) => c.baseImponible) },
      { casillero: "609", label: "Retenciones de IVA que le han sido efectuadas", valor: ats.totals.retIvaRecibidas },
      { casillero: "721", label: "Retención de IVA efectuada 10%", valor: withheld["10"] },
      { casillero: "723", label: "Retención de IVA efectuada 20%", valor: withheld["20"] },
      { casillero: "725", label: "Retención de IVA efectuada 30%", valor: withheld["30"] },
      { casillero: "727", label: "Retención de IVA efectuada 50%", valor: withheld["50"] },
      { casillero: "729", label: "Retención de IVA efectuada 70%", valor: withheld["70"] },
      { casillero: "731", label: "Retención de IVA efectuada 100%", valor: withheld["100"] },
    ],
  };
}
