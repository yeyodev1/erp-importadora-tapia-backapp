import { sum, formatCents } from "../utils/money";
import { buildPlan, MacioPlan } from "./migrationPlan.service";

/**
 * Vista previa de Macio en lenguaje claro: lo que se va a crear, lo que ya
 * existe, lo que se excluye y por qué. No graba nada.
 */
const ID_LABEL: Record<string, string> = { "04": "RUC", "05": "Cédula", "06": "Pasaporte", "07": "Consumidor final" };

export function presentPlan(plan: MacioPlan) {
  const { parsed, clients, existingParties, invoices, unmatched, products } = plan;
  const invalid = clients.filter((c) => c.problem);
  const sellerCustomers = new Map<string, number>();
  for (const c of clients) sellerCustomers.set(c.sellerCode, (sellerCustomers.get(c.sellerCode) ?? 0) + 1);
  const toImport = sum(invoices.map((i) => i.balance));
  const stockLines = products.flatMap((p) => p.stock.map((s) => ({ ...s, product: p })));
  const byWarehouse = ["GYE", "UIO"].map((w) => {
    const lines = stockLines.filter((l) => l.warehouse === w);
    return { warehouse: w, name: plan.warehouses.get(w)?.name ?? w, lines: lines.length, qty: Math.round(sum(lines.map((l) => l.qty)) * 10000) / 10000 };
  });
  const ambiguous = invoices.filter((i) => i.ambiguous);

  const notices = [
    `Notas de crédito excluidas: ${parsed.creditNotes.count} por $${formatCents(parsed.creditNotes.total)}. En Macio ya se usaron para bajar el saldo de las facturas; cargarlas otra vez descontaría dos veces.`,
    "Inventario: entra la cantidad de Macio a costo $0 (sin asiento). El inventario valorizado queda en $0 hasta que lleguen los costos de Macio; ese ajuste se hará aparte.",
    "Productos: la unidad de compra queda igual a la de control con factor 1 (factor pendiente). El grupo es sugerido por el nombre: revísalo en la ficha.",
    `Cartera: cada factura abierta entra como saldo inicial con su número, fecha y vencimiento originales. Un solo asiento: Debe Clientes / Haber Saldo inicial por $${formatCents(toImport)}, con fecha de hoy.`,
    "Los saldos iniciales no son ventas del período: no salen en reportes de ventas, ATS ni SRI.",
  ];
  if (ambiguous.length) notices.push(`${ambiguous.length} facturas son de un nombre que se repite en clientes: se asignan al cliente con RUC válido (revisa la lista).`);
  if (parsed.otherDocs) notices.push(`${parsed.otherDocs} documentos de cartera que no son factura ni nota de crédito se ignoran.`);

  return {
    counts: {
      clientRows: parsed.clients.length,
      clients: clients.length,
      newClients: clients.filter((c) => !existingParties.has(c.identification)).length,
      existingClients: clients.filter((c) => existingParties.has(c.identification)).length,
      repeatedInFile: plan.repeated.length,
      withoutId: plan.withoutId.length,
      invalidIds: invalid.length,
      sellers: parsed.sellers.length,
      products: products.length,
      newProducts: products.filter((p) => !p.existing).length,
      existingProducts: products.filter((p) => p.existing && !p.conflict).length,
      conflicts: products.filter((p) => p.conflict).length,
      stockLines: stockLines.length,
      invoices: invoices.length,
      unmatchedInvoices: unmatched.length,
      ambiguousInvoices: ambiguous.length,
      creditNotes: parsed.creditNotes.count,
    },
    totals: {
      receivables: toImport,
      invoiceTotals: sum(invoices.map((i) => i.total)),
      paid: sum(invoices.map((i) => i.paid)),
      unmatched: sum(unmatched.map((i) => i.balance)),
      creditNotes: parsed.creditNotes.total,
    },
    invalidClients: invalid.map((c) => ({ macioCode: c.macioCode, name: c.name, identification: c.identification, idType: ID_LABEL[c.idType], problem: c.problem })),
    repeatedClients: plan.repeated.map((c) => ({ macioCode: c.macioCode, name: c.name, identification: c.identification })),
    sellers: parsed.sellers.map((v) => ({ ...v, customers: sellerCustomers.get(v.code) ?? 0 })),
    products: products.map((p) => ({
      code: p.code, name: p.name, unit: p.unit, group: p.group, suggested: true,
      status: p.conflict ? "conflicto" : p.existing ? "existente" : "nuevo", existingName: p.existing?.name ?? "",
      gye: sum(p.stock.filter((s) => s.warehouse === "GYE").map((s) => s.qty)),
      uio: sum(p.stock.filter((s) => s.warehouse === "UIO").map((s) => s.qty)),
    })),
    stock: byWarehouse,
    invoices: invoices.map((i) => ({
      number: i.number, customer: i.client.name, identification: i.client.identification, warehouse: i.warehouse,
      date: i.date, dueDate: i.dueDate, total: i.total, paid: i.paid, balance: i.balance, ambiguous: i.ambiguous,
    })),
    unmatchedInvoices: unmatched.map((i) => ({ number: i.number, customer: i.customerName, balance: i.balance })),
    notices,
    warnings: plan.warnings,
    blockers: plan.blockers,
    canApply: plan.blockers.length === 0 && (clients.length > 0 || invoices.length > 0 || products.length > 0),
  };
}

export async function previewMacio(data: unknown) {
  return presentPlan(await buildPlan(data));
}
