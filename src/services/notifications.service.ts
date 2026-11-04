import type { Model } from "mongoose";
import { BankReconciliation } from "../models/bankReconciliation.model";
import { PaymentApproval } from "../models/paymentApproval.model";
import { PurchaseInvoice } from "../models/purchaseInvoice.model";
import { SalesCreditNote } from "../models/salesCreditNote.model";
import { SalesDebitNote } from "../models/salesDebitNote.model";
import { SalesInvoice } from "../models/salesInvoice.model";
import { StockBalance } from "../models/stockBalance.model";
import type { Role } from "../models/user.model";
import { dayRange } from "../utils/dates";
import { formatCents } from "../utils/money";
import { lowStock, overduePayables, postdatedChecksDue } from "./dashboard.service";
import { periodBounds, todayStr } from "./ledgerReports.service";
import * as settingsService from "./settings.service";

/**
 * Avisos de la campana: se calculan al vuelo en cada consulta (no se guardan).
 * El `id` es estable por tipo de aviso para que el front recuerde cuáles ya vio;
 * si `count` cambia, el aviso vuelve a contar como nuevo. `link` es una ruta del front.
 */
export type Level = "info" | "warning" | "danger" | "success";
export interface Notice {
  id: string;
  level: Level;
  icon: string;
  title: string;
  message: string;
  count: number;
  link: string;
  createdAt: string;
}

const DAY = 86_400_000;
const LEVEL_ORDER: Level[] = ["danger", "warning", "info", "success"];
const SRI_DANGER = ["devuelto", "no_autorizado", "error"];
// Contabilidad, auditor y gerencia (admin pasa siempre) ven todos los avisos.
const ALL: Role[] = ["contabilidad", "auditor"];

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const iso = (d: unknown) => (d ? new Date(d as Date).toISOString() : new Date().toISOString());

interface Ctx {
  todayStart: Date;
  todayEnd: Date;
  prevPeriod: string;
}

type Rule = { roles: Role[]; run: (ctx: Ctx) => Promise<Notice[]> };

/** Comprobantes de un modelo por estado SRI → un aviso rojo (rechazados) y uno ámbar (sin firma). */
async function sriNotices(model: Model<any>, field: string, kind: string, label: string, link: string, extra: Record<string, unknown> = {}) {
  const rows = await model.aggregate([
    { $match: { status: "vigente", ...extra, [field]: { $in: [...SRI_DANGER, "sin_firma"] } } },
    { $group: { _id: { $cond: [{ $eq: [`$${field}`, "sin_firma"] }, "warning", "danger"] }, n: { $sum: 1 }, last: { $max: "$updatedAt" } } },
  ]);
  return rows.map((r): Notice => {
    const danger = r._id === "danger";
    return {
      id: `sri-${kind}-${r._id}`,
      level: r._id,
      icon: danger ? "alert-circle" : "key",
      title: danger ? `${label} rechazadas por el SRI` : `${label} sin firma electrónica`,
      message: danger
        ? `${plural(r.n, "comprobante devuelto o no autorizado", "comprobantes devueltos o no autorizados")}. Revisa el motivo y reintenta el envío.`
        : `${plural(r.n, "comprobante quedó", "comprobantes quedaron")} sin firmar: falta el certificado .p12. Reintenta cuando esté cargado.`,
      count: r.n,
      link: `${link}?sriStatus=${danger ? "devuelto" : "sin_firma"}`,
      createdAt: iso(r.last),
    };
  });
}

async function overdueReceivables({ todayStart }: Ctx): Promise<Notice[]> {
  const d30 = new Date(todayStart.getTime() - 30 * DAY);
  const d90 = new Date(todayStart.getTime() - 90 * DAY);
  const rows = await SalesInvoice.aggregate([
    { $match: { status: "vigente", balance: { $gt: 0 }, dueDate: { $lt: d30 } } },
    { $group: { _id: { $cond: [{ $lt: ["$dueDate", d90] }, "danger", "warning"] }, n: { $sum: 1 }, amount: { $sum: "$balance" }, last: { $max: "$dueDate" } } },
  ]);
  return rows.map((r) => ({
    id: `cxc-overdue-${r._id === "danger" ? 90 : 30}`,
    level: r._id,
    icon: "receivables",
    title: r._id === "danger" ? "Cartera vencida a más de 90 días" : "Cartera vencida de 31 a 90 días",
    message: `${plural(r.n, "factura", "facturas")} de clientes por $${formatCents(r.amount)}. Gestiona el cobro.`,
    count: r.n,
    link: `/cxc/cartera-edades?bucket=${r._id === "danger" ? "d90" : "d30"}`,
    createdAt: iso(r.last),
  }));
}

async function checks({ todayEnd }: Ctx): Promise<Notice[]> {
  // "Hoy" incluye los que ya vencieron y siguen en cartera: hay que depositarlos ya.
  const [due, week] = await Promise.all([postdatedChecksDue(new Date(0), todayEnd), postdatedChecksDue(new Date(todayEnd.getTime() + 1), new Date(todayEnd.getTime() + 7 * DAY))]);
  const out: Notice[] = [];
  const now = new Date().toISOString();
  if (due.count) out.push({ id: "checks-today", level: "danger", icon: "wallet", title: "Cheques posfechados para depositar hoy", message: `${plural(due.count, "cheque", "cheques")} por $${formatCents(due.amount)} vencen hoy o ya vencieron y siguen en cartera.`, count: due.count, link: "/cxc/cheques-posfechados?status=en_cartera", createdAt: now });
  if (week.count) out.push({ id: "checks-week", level: "warning", icon: "calendar", title: "Cheques posfechados por vencer", message: `${plural(week.count, "cheque vence", "cheques vencen")} en los próximos 7 días por $${formatCents(week.amount)}.`, count: week.count, link: "/cxc/cheques-posfechados?status=en_cartera", createdAt: now });
  return out;
}

async function payables({ todayStart }: Ctx): Promise<Notice[]> {
  const [overdue, approved] = await Promise.all([
    overduePayables(todayStart),
    PaymentApproval.aggregate([{ $match: { status: "pendiente" } }, { $group: { _id: null, n: { $sum: 1 }, amount: { $sum: "$total" }, last: { $max: "$updatedAt" } } }]),
  ]);
  const out: Notice[] = [];
  if (overdue.count) out.push({ id: "cxp-overdue", level: "warning", icon: "payables", title: "Facturas de proveedores vencidas", message: `${plural(overdue.count, "factura", "facturas")} por pagar por $${formatCents(overdue.amount)} ya pasaron su plazo.`, count: overdue.count, link: "/cxp/saldos", createdAt: new Date().toISOString() });
  const a = approved[0];
  if (a?.n) out.push({ id: "cxp-approved", level: "info", icon: "check-circle", title: "Pagos aprobados por emitir", message: `${plural(a.n, "aprobación", "aprobaciones")} por $${formatCents(a.amount)} esperan el cheque o la transferencia.`, count: a.n, link: "/cxp/pagos", createdAt: iso(a.last) });
  return out;
}

async function stock(): Promise<Notice[]> {
  const [low, negative] = await Promise.all([lowStock(), StockBalance.countDocuments({ qty: { $lt: 0 } })]);
  const now = new Date().toISOString();
  const out: Notice[] = [];
  if (negative) out.push({ id: "stock-negative", level: "danger", icon: "inventory", title: "Stock negativo", message: `${plural(negative, "producto quedó", "productos quedaron")} con existencia negativa en alguna bodega. Revisa el kardex.`, count: negative, link: "/inventario/negativos", createdAt: now });
  if (low.products) out.push({ id: "stock-low", level: "warning", icon: "box", title: "Stock bajo el mínimo", message: `${plural(low.products, "producto está", "productos están")} por debajo del mínimo de su ficha. Conviene reponer.`, count: low.products, link: "/inventario/bajo-minimo", createdAt: now });
  return out;
}

async function closing({ prevPeriod }: Ctx): Promise<Notice[]> {
  const { end } = periodBounds(prevPeriod);
  const [open, settings] = await Promise.all([
    BankReconciliation.aggregate([{ $match: { status: "abierta", from: { $lte: end } } }, { $group: { _id: null, n: { $sum: 1 }, last: { $max: "$updatedAt" } } }]),
    settingsService.get() as Promise<any>,
  ]);
  const out: Notice[] = [];
  if (open[0]?.n) out.push({ id: "bank-reconciliations", level: "warning", icon: "bank", title: "Conciliaciones bancarias abiertas", message: `${plural(open[0].n, "conciliación", "conciliaciones")} de ${prevPeriod} o antes siguen sin cerrar.`, count: open[0].n, link: "/bancos/conciliacion?status=abierta", createdAt: iso(open[0].last) });
  if (!settings.lockedThrough || settings.lockedThrough < prevPeriod) {
    out.push({ id: `period-open-${prevPeriod}`, level: "warning", icon: "lock", title: `El mes ${prevPeriod} sigue abierto`, message: "Cierra el mes cuando la contabilidad esté cuadrada para que nadie grabe con esa fecha.", count: 1, link: "/contabilidad/cierre-meses", createdAt: iso(settings.updatedAt) });
  }
  if (settings.sriEnvironment !== 2) {
    out.push({ id: "sri-test-environment", level: "warning", icon: "alert", title: "SRI en ambiente de PRUEBAS", message: "Las facturas que se emitan no tienen validez tributaria. Pasa a producción en Configuración › Empresa.", count: 1, link: "/configuracion/empresa", createdAt: iso(settings.updatedAt) });
  }
  return out;
}

/** Qué ve cada rol: bodega stock; cartera cobros y cheques; facturación SRI de ventas; contabilidad y gerencia todo. */
const RULES: Rule[] = [
  {
    roles: ["facturacion", ...ALL],
    run: async () =>
      (
        await Promise.all([
          sriNotices(SalesInvoice, "sriStatus", "invoices", "Facturas", "/facturacion/facturas"),
          sriNotices(SalesCreditNote, "sriStatus", "credit-notes", "Notas de crédito", "/facturacion/notas-credito"),
          sriNotices(SalesDebitNote, "sriStatus", "debit-notes", "Notas de débito", "/facturacion/notas-debito"),
        ])
      ).flat(),
  },
  { roles: ALL, run: () => sriNotices(PurchaseInvoice, "withholding.sriStatus", "withholdings", "Retenciones", "/cxp/retenciones-emitidas") },
  { roles: ["cartera", ...ALL], run: overdueReceivables },
  { roles: ["cartera", ...ALL], run: checks },
  { roles: ALL, run: payables },
  { roles: ["bodega", ...ALL], run: stock },
  { roles: ALL, run: closing },
];

export async function listNotifications(role: Role): Promise<Notice[]> {
  const today = todayStr();
  const range = dayRange(today, today)!;
  const [y, m] = today.split("-").map(Number);
  const prevPeriod = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const ctx: Ctx = { todayStart: range.$gte!, todayEnd: range.$lte!, prevPeriod };
  const rules = RULES.filter((r) => role === "admin" || r.roles.includes(role));
  const notices = (await Promise.all(rules.map((r) => r.run(ctx)))).flat();
  return notices.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level));
}
