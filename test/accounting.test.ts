import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, ACTOR, day } from "./helpers";
import { runInTransaction } from "../src/config/transaction";
import * as accounting from "../src/services/accounting.service";
import * as journal from "../src/services/journal.service";
import * as reports from "../src/services/ledgerReports.service";
import * as statements from "../src/services/financialStatements.service";
import * as yearClose from "../src/services/yearClose.service";
import * as chartImport from "../src/services/chartImport.service";
import { Account } from "../src/models/account.model";
import { Settings } from "../src/models/settings.model";

before(setup);
after(teardown);

const BANK = "1.1.01.02.01.004";
const OTHER_BANK = "1.1.01.02.01.005";
const RETAINED = "3.1.01.01.01.001";
const YEAR_RESULT = "3.1.01.01.01.002";

const manual = (date: string, description: string, lines: any[], subtype = "asiento_diario") =>
  journal.createManual({ date, description, subtype, lines }, ACTOR);

let voidable: any;

test("comprobantes manuales del 2025 y anulación con motivo", async () => {
  await manual("2025-03-10", "Aporte inicial", [
    { accountCode: BANK, debit: 100000 },
    { accountCode: RETAINED, credit: 100000 },
  ]);
  await manual("2025-03-20", "Importación de mercadería", [
    { accountCode: "1.1.03.01.01.001", debit: 30000 },
    { accountCode: "1.1.03.01.01.002", debit: 20000 },
    { accountCode: BANK, credit: 50000 },
  ], "importacion");
  await manual("2025-06-15", "Venta", [
    { accountCode: "1.1.02.01.01.001", debit: 57500 },
    { accountCode: "4.1.01.01.01.001", credit: 30000 },
    { accountCode: "4.1.01.01.01.002", credit: 20000 },
    { accountCode: "2.1.02.01.01.001", credit: 7500 },
  ]);
  await manual("2025-06-15", "Costo de venta", [
    { accountCode: "5.1.01.01.01.001", debit: 18000 },
    { accountCode: "5.1.01.01.01.002", debit: 12000 },
    { accountCode: "1.1.03.01.01.001", credit: 18000 },
    { accountCode: "1.1.03.01.01.002", credit: 12000 },
  ]);
  await manual("2025-07-01", "Luz", [
    { accountCode: "5.2.02.01.01.003", debit: 5000 },
    { accountCode: BANK, credit: 5000 },
  ]);
  await manual("2025-07-05", "Traspaso entre bancos", [
    { accountCode: OTHER_BANK, debit: 10000 },
    { accountCode: BANK, credit: 10000 },
  ]);
  voidable = await manual("2025-08-01", "Gasto mal registrado", [
    { accountCode: "5.2.02.01.01.006", debit: 7000 },
    { accountCode: BANK, credit: 7000 },
  ], "depreciacion");
  assert.equal(voidable.subtype, "depreciacion");

  await assert.rejects(journal.voidManual(String(voidable._id), {}, ACTOR), /motivo/);
  await journal.voidManual(String(voidable._id), { reason: "error de cuenta", date: "2025-08-02" }, ACTOR);
  const detail = await journal.getEntry(String(voidable._id));
  assert.equal(detail.status, "anulado");
  assert.equal(detail.audit.user, ACTOR.name);
  assert.match(detail.audit.time!, /^\d{2}:\d{2}:\d{2}$/);
  assert.ok(detail.reversedByEntry);
});

test("un asiento de otro módulo no se anula desde contabilidad", async () => {
  const sale = await runInTransaction((s) =>
    accounting.postEntry(
      {
        date: day("2026-01-10"),
        type: "VENTA",
        description: "Factura",
        source: { module: "ventas", docType: "FACTURA", docNumber: "001-001-000000001" },
        lines: [
          { accountCode: "1.1.02.01.01.001", debit: 1150 },
          { accountCode: "4.1.01.01.01.003", credit: 1000 },
          { accountCode: "2.1.02.01.01.001", credit: 150 },
        ],
      },
      ACTOR,
      s,
    ),
  );
  await assert.rejects(journal.voidManual(String(sale._id), { reason: "x" }, ACTOR), /desde su módulo/);
  const found = await journal.search({ module: "ventas", q: "000000001" });
  assert.equal(found.total, 1);
});

test("balance de comprobación cuadra y la cuenta de mayor suma sus hijas", async () => {
  const tb = await reports.trialBalance({ period: "2025-12", mode: "acumulado" });
  assert.equal(tb.cuadra, true);
  assert.equal(tb.totals.debit, tb.totals.credit);
  const row = (code: string) => tb.rows.find((r) => r.code === code)!;
  // BANCOS NACIONALES = Pichincha (100000 − 50000 − 5000 − 10000 − 7000 + 7000) + Guayaquil 10000
  assert.equal(row(BANK).balance, 35000);
  assert.equal(row("1.1.01.02.01").balance, 45000);
  assert.equal(row("1.1.01.02.01").debit, row(BANK).debit + row(OTHER_BANK).debit);
  assert.equal(row("4").balance, -50000);

  const onlyMayor = await reports.trialBalance({ period: "2025-12", filter: "mayor" });
  assert.ok(onlyMayor.rows.every((r) => r.kind === "mayor"));

  const monthly = await reports.trialBalance({ period: "2025-07", mode: "mensual" });
  assert.equal(monthly.cuadra, true);
  assert.equal(monthly.rows.find((r) => r.code === BANK)!.previous, 50000);
});

test("libro mayor con saldo anterior, saldo corrido y cuenta de mayor", async () => {
  const l = await reports.ledger({ account: BANK, from: "2025-06-01", to: "2025-12-31" });
  assert.equal(l.previousBalance, 50000);
  assert.equal(l.movements.length, 4); // luz, traspaso, gasto anulado y su reverso
  assert.equal(l.balance, 35000);
  assert.equal(l.movements.at(-1)!.balance, 35000);

  const clean = await reports.ledger({ account: BANK, from: "2025-06-01", to: "2025-12-31", excludeVoided: "true" });
  assert.equal(clean.movements.length, 2);
  assert.equal(clean.balance, 35000);

  const parent = await reports.ledger({ account: "1.1.01.02", from: "2025-06-01", to: "2025-12-31" });
  assert.equal(parent.previousBalance, 50000);
  assert.equal(parent.balance, 45000);
});

test("estado de resultados con utilidad por grupo", async () => {
  const r = await statements.incomeStatement({ from: "2025-01-01", to: "2025-12-31" });
  assert.equal(r.income.total, 50000);
  assert.equal(r.costsAndExpenses.total, 35000);
  assert.equal(r.utility, 15000);
  const especias = r.byProductGroup.find((g) => g.group === "ESPECIAS")!;
  assert.deepEqual([especias.sales, especias.cost, especias.grossMargin], [30000, 18000, 12000]);
  assert.equal(r.income.rows.find((x) => x.code === "4.1.01.01.01.001")!.amount, 30000);
});

test("balance general cuadra con la utilidad del ejercicio en curso", async () => {
  const b = await statements.balanceSheet({ date: "2025-12-31" });
  assert.equal(b.equity.currentYearResult, 15000);
  assert.equal(b.assets.total, 122500);
  assert.equal(b.liabilities.total, 7500);
  assert.equal(b.equity.total, 115000);
  assert.equal(b.cuadra, true);
});

test("cierre anual: 4 y 5 en cero, no se repite, bloquea y se reabre", async () => {
  const { entry, result, lockedThrough } = await yearClose.closeYear({ year: 2025 }, ACTOR);
  assert.equal(entry.type, "CIERRE");
  assert.equal(result, 15000);
  assert.equal(lockedThrough, "2025-12");

  const tb = await reports.trialBalance({ period: "2025-12" });
  assert.equal(tb.cuadra, true);
  for (const code of ["4", "5"]) assert.equal(tb.rows.find((r) => r.code === code)!.balance, 0);
  assert.equal(tb.rows.find((r) => r.code === YEAR_RESULT)!.balance, -15000);

  const b = await statements.balanceSheet({ date: "2025-12-31" });
  assert.equal(b.equity.currentYearResult, 0);
  assert.equal(b.cuadra, true);
  // El estado de resultados del año no se borra con el cierre.
  assert.equal((await statements.incomeStatement({ from: "2025-01-01", to: "2025-12-31" })).utility, 15000);

  await assert.rejects(yearClose.closeYear({ year: 2025 }, ACTOR), /ya está cerrado/);
  await assert.rejects(journal.createManual({ date: "2025-12-15", description: "tarde", lines: [
    { accountCode: BANK, debit: 100 }, { accountCode: RETAINED, credit: 100 },
  ] }, ACTOR), /cerrado/);

  const reopened = await yearClose.reopenYear(2025, { reason: "ajuste de auditoría" }, ACTOR);
  assert.equal(reopened.lockedThrough, "2025-11");
  const again = await yearClose.closeYear({ year: 2025, transferToRetained: true }, ACTOR);
  assert.equal(again.result, 15000);
  const after = await reports.trialBalance({ period: "2025-12" });
  assert.equal(after.rows.find((r) => r.code === YEAR_RESULT)?.balance ?? 0, 0);
  assert.equal(after.rows.find((r) => r.code === RETAINED)!.balance, -115000);
  assert.equal((await Settings.findById("main").lean<any>()).lockedThrough, "2025-12");
});

test("importar plan de cuentas: rechaza hijo sin padre y aplica lo válido", async () => {
  const bad = await chartImport.importChart({
    mode: "preview",
    csv: "codigo;nombre;tipo\n6;CUENTAS DE ORDEN;mayor\n6.1.01;Hijo sin padre;movimiento\n",
  });
  assert.equal(bad.valid, false);
  assert.match(bad.errors.join("\n"), /no tiene su cuenta padre 6\.1/);
  await assert.rejects(chartImport.importChart({ mode: "apply", csv: "6.1.01;Hijo sin padre;movimiento" }), /no se grabó/);
  assert.equal(await Account.countDocuments({ code: /^6/ }), 0);

  // Pichincha tiene movimientos: no puede pasar a mayor.
  const used = await chartImport.importChart({ mode: "preview", csv: `${BANK};Banco Pichincha;mayor` });
  assert.match(used.errors[0], /tiene movimientos/);

  const ok = await chartImport.importChart({
    mode: "apply",
    csv: `6;CUENTAS DE ORDEN;mayor\n6.1;DEUDORAS;mayor\n6.1.01;Garantías;movimiento\n${BANK};Banco Pichincha Cta Cte;movimiento`,
  });
  assert.deepEqual([ok.created, ok.updated], [3, 1]);
  assert.equal((await Account.findOne({ code: "6.1.01" }).lean<any>()).parentCode, "6.1");
  assert.equal((await Account.findOne({ code: BANK }).lean<any>()).name, "Banco Pichincha Cta Cte");
});
