import { ProductGroup } from "../models/productGroup.model";
import { dayRange } from "../utils/dates";
import { accountsFor, entryMatch, isTrue, rollup, Sums, sumsByAccount, todayStr } from "./ledgerReports.service";

/**
 * Estado de resultados y balance general, desde la misma agregación de
 * JournalEntry.lines. Aquí cada sección se presenta en positivo según su
 * naturaleza (el sistema anterior mostraba los ingresos con signo negativo).
 */
type Query = Record<string, unknown>;

const RESULTS = /^[45](\.|$)/;
const creditMinusDebit = (s?: Sums) => (s ? s.credit - s.debit : 0);
const debitMinusCredit = (s?: Sums) => (s ? s.debit - s.credit : 0);
/** Naturaleza: 1 y 5 deudoras; 2, 3 y 4 acreedoras. */
const natural = (code: string, s?: Sums) => (/^[15]/.test(code) ? debitMinusCredit(s) : creditMinusDebit(s));

function treeRows(accounts: any[], sums: Map<string, Sums>) {
  return accounts
    .map((a) => ({ code: a.code, name: a.name, kind: a.kind, level: a.level, amount: natural(a.code, sums.get(a.code)) }))
    .filter((r) => r.amount !== 0 || sums.has(r.code));
}

/**
 * Estado de resultados por rango: cuentas 4 y 5 en árbol (los grupos de
 * producto salen como están en el plan) y resumen por grupo de producto.
 * El asiento CIERRE se excluye: si no, diciembre saldría en cero.
 */
export async function incomeStatement(q: Query) {
  const year = todayStr().slice(0, 4);
  const from = String(q.from ?? `${year}-01-01`);
  const to = String(q.to ?? todayStr());
  const match = entryMatch(dayRange(from, to), isTrue(q.excludeVoided), ["CIERRE"]);
  const [own, accounts, groups] = await Promise.all([
    sumsByAccount(match, RESULTS),
    accountsFor({ code: RESULTS }),
    ProductGroup.find({ isActive: true }).sort({ name: 1 }).lean<any[]>(),
  ]);
  const sums = rollup(own);
  const income = creditMinusDebit(sums.get("4"));
  const costsAndExpenses = debitMinusCredit(sums.get("5"));

  return {
    from,
    to,
    signConvention:
      "Ingresos (4) = haber − debe y costos/gastos (5) = debe − haber: ambos en positivo. Un descuento en ventas resta ingresos. Utilidad = ingresos − costos y gastos.",
    income: { total: income, rows: treeRows(accounts.filter((a) => a.code.startsWith("4")), sums) },
    costsAndExpenses: {
      total: costsAndExpenses,
      rows: treeRows(accounts.filter((a) => a.code.startsWith("5")), sums),
    },
    byProductGroup: groups.map((g) => {
      const sales = creditMinusDebit(sums.get(g.accounts.sales));
      const cost = debitMinusCredit(sums.get(g.accounts.cost));
      return { group: g.name, salesAccount: g.accounts.sales, costAccount: g.accounts.cost, sales, cost, grossMargin: sales - cost };
    }),
    utility: income - costsAndExpenses,
  };
}

/**
 * Balance general a una fecha. El resultado no cerrado (lo que queda en 4 y
 * 5, que el cierre anual lleva a cero) entra al patrimonio como utilidad del
 * ejercicio en curso; sin eso el balance no cuadra antes del cierre.
 */
export async function balanceSheet(q: Query) {
  const date = String(q.date ?? todayStr());
  const range = dayRange(undefined, date);
  const [own, accounts] = await Promise.all([
    sumsByAccount(entryMatch(range, isTrue(q.excludeVoided))),
    accountsFor({ code: /^[123](\.|$)/ }),
  ]);
  const sums = rollup(own);
  const currentYearResult = creditMinusDebit(sums.get("4")) + creditMinusDebit(sums.get("5"));
  const section = (root: string) => ({
    total: natural(root, sums.get(root)),
    rows: treeRows(accounts.filter((a) => a.code === root || a.code.startsWith(`${root}.`)), sums),
  });
  const assets = section("1");
  const liabilities = section("2");
  const equityAccounts = section("3");
  const equity = {
    total: equityAccounts.total + currentYearResult,
    rows: equityAccounts.rows,
    currentYearResult,
  };

  return {
    date,
    signConvention: "Cada sección en positivo según su naturaleza: activo = debe − haber; pasivo y patrimonio = haber − debe.",
    assets,
    liabilities,
    equity,
    liabilitiesAndEquity: liabilities.total + equity.total,
    cuadra: assets.total === liabilities.total + equity.total,
  };
}
