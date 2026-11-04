import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, ACTOR } from "./helpers";
import { BankAccount } from "../src/models/bankAccount.model";
import { BankMovement } from "../src/models/bankMovement.model";
import { BankReconciliation } from "../src/models/bankReconciliation.model";
import { JournalEntry } from "../src/models/journalEntry.model";
import * as tx from "../src/services/bankTransactions.service";
import * as balances from "../src/services/bankBalances.service";
import * as rec from "../src/services/bankReconciliation.service";
import * as statement from "../src/services/bankStatement.service";
import { parseAmount, parseStatement } from "../src/services/bankStatementParser.service";

before(setup);
after(teardown);

const EXPENSE = "5.2.02.01.01.006";
const CUSTOMERS = "1.1.02.01.01.001";
const bank = (name: string) => BankAccount.findOne({ name }).lean<any>();

test("nota de débito genera asiento BANCO y movimiento de salida", async () => {
  const gye = await bank("Banco de Guayaquil");
  const nd = await tx.createTransaction(
    { type: "NOTA_DEBITO", bankAccountId: gye._id, date: "2026-10-05", note: "Comisión", lines: [{ accountCode: EXPENSE, amount: 1250, costCenter: "ADM" }] },
    ACTOR,
  );
  assert.equal(nd.description, "NOTA DE DÉBITO del Banco de Guayaquil - Comisión");
  const entry = await JournalEntry.findById(nd.journalEntryId).lean<any>();
  assert.equal(entry.type, "BANCO");
  assert.deepEqual(entry.lines.map((l: any) => [l.accountCode, l.debit, l.credit]), [[gye.accountCode, 0, 1250], [EXPENSE, 1250, 0]]);
  assert.equal(entry.lines[1].costCenter, "ADM");
  const mov = await BankMovement.findOne({ "source.docId": nd._id }).lean<any>();
  assert.equal(mov.direction, "out");
  assert.equal(mov.amount, 1250);
  const bal = await balances.balanceOf(String(gye._id), "2026-10-31");
  assert.equal(bal.accountingBalance, -1250);
  assert.equal(bal.movementBalance, -1250);
});

test("cheque suelto anulado revierte asiento y movimiento; el número no se reutiliza", async () => {
  const pich = await bank("Banco Pichincha");
  const ch = await tx.createTransaction(
    { type: "CHEQUE", bankAccountId: pich._id, date: "2026-10-07", beneficiary: "SUPERINTENDENCIA DE COMPAÑÍAS", lines: [{ accountCode: EXPENSE, amount: 45000 }] },
    ACTOR,
  );
  assert.equal(ch.description, "CHEQUE # 1 del Banco Pichincha - SUPERINTENDENCIA DE COMPAÑÍAS");
  await tx.voidTransaction(String(ch._id), { reason: "Error en el valor" }, ACTOR);
  const mov = await BankMovement.findOne({ "source.docId": ch._id }).lean<any>();
  assert.equal(mov.status, "anulado");
  assert.equal((await JournalEntry.findById(ch.journalEntryId).lean<any>()).status, "anulado");
  assert.equal((await balances.balanceOf(String(pich._id), "2026-10-31")).accountingBalance, 0);
  const again = await tx.createTransaction(
    { type: "CHEQUE", bankAccountId: pich._id, date: "2026-10-07", beneficiary: "SUPERINTENDENCIA DE COMPAÑÍAS", lines: [{ accountCode: EXPENSE, amount: 4500 }] },
    ACTOR,
  );
  assert.equal(again.checkNumber, "2");
  await assert.rejects(tx.voidTransaction(String(ch._id), { reason: "x" }, ACTOR), /ya está anulada/);
});

test("parser: separadores, fechas y montos con coma o punto", () => {
  assert.equal(parseAmount("1.234,56"), 123456);
  assert.equal(parseAmount("1,234.56"), 123456);
  assert.equal(parseAmount("150.25"), 15025);
  assert.equal(parseAmount("(80,00)"), -8000);
  assert.equal(parseAmount("0.10"), 10);
  const p = parseStatement('fecha,concepto,valor\n2026-10-03,"DEPOSITO 1,000.50",1000.50\n2026-10-04,RETIRO,-20.00\nTOTAL,,980.50');
  assert.equal(p.separator, ",");
  assert.deepEqual(p.lines.map((l) => [l.amount, l.direction]), [[100050, "in"], [2000, "out"]]);
});

test("conciliación cuadra, arrastra el cheque pendiente y el CSV solo propone hasta confirmar", async () => {
  const austro = await bank("Banco del Austro");
  const mk = (body: any) => tx.createTransaction({ bankAccountId: austro._id, ...body }, ACTOR);
  await mk({ type: "DEPOSITO", date: "2026-09-02", lines: [{ accountCode: CUSTOMERS, amount: 100000 }] });
  await mk({ type: "CHEQUE", date: "2026-09-10", beneficiary: "PROVEEDOR A", lines: [{ accountCode: EXPENSE, amount: 20000 }] });
  const chB = await mk({ type: "CHEQUE", date: "2026-09-20", beneficiary: "PROVEEDOR B", lines: [{ accountCode: EXPENSE, amount: 5000 }] });

  // Septiembre: el banco cobró el depósito y el cheque A; B sigue en circulación.
  const sep = await rec.createReconciliation({ bankAccountId: austro._id, from: "2026-09-01", to: "2026-09-30", statementBalance: 80000 }, ACTOR);
  let view: any = await rec.loadMovements(String(sep._id));
  assert.equal(view.movements.length, 3);
  const clearedSep = view.movements.filter((m: any) => m.checkNumber !== chB.checkNumber).map((m: any) => m._id);
  view = await rec.updateReconciliation(String(sep._id), { clearedIds: clearedSep });
  assert.equal(view.summary.bookBalance, 75000);
  assert.equal(view.summary.adjustedBalance, 75000);
  assert.equal(view.summary.message, "Conciliación cuadrada");
  await rec.closeReconciliation(String(sep._id), {}, ACTOR);
  assert.equal(await BankMovement.countDocuments({ reconciliationId: sep._id }), 2);
  await assert.rejects(rec.updateReconciliation(String(sep._id), { statementBalance: 1 }), /cerrada/);
  const sepReport = await rec.reconciliationReport(String(sep._id));
  assert.equal(sepReport.outstandingChecks.total, 5000);
  assert.equal(sepReport.reconciledBankBalance, 75000);
  assert.equal(sepReport.totalRecords, 3);

  // Octubre: B se arrastra como "meses anteriores".
  await mk({ type: "NOTA_DEBITO", date: "2026-10-05", lines: [{ accountCode: EXPENSE, amount: 300 }] });
  const oct = await rec.createReconciliation({ bankAccountId: austro._id, from: "2026-10-01", to: "2026-10-31", statementBalance: 74550 }, ACTOR);
  view = await rec.loadMovements(String(oct._id));
  assert.equal(view.movements.length, 2);
  const chequeRow = view.summary.rows.find((r: any) => r.type === "CHEQUE");
  assert.equal(chequeRow.previousMonths, 5000);
  assert.equal(view.summary.difference, 74550 - 5300 - 74700);

  const csv = [
    "Banco del Austro - Estado de cuenta 0000000000",
    "Fecha;Descripción;Referencia;Débito;Crédito;Saldo",
    `12/10/2026;CHEQUE PAGADO;000${chB.checkNumber};50,00;;79.950,00`,
    "06/10/2026;NOTA DEBITO;;3,00;;79.947,00",
    "31/10/2026;COMISION MANTENIMIENTO;;1,50;;79.945,50",
  ].join("\r\n");
  const match = await statement.matchStatement(String(oct._id), { csv });
  assert.equal(match.separator, ";");
  assert.deepEqual(match.proposals.map((p) => p.rule).sort(), ["cheque", "monto_fecha"]);
  assert.equal(match.unmatchedLines.length, 1);
  assert.equal(match.unmatchedLines[0].amount, 150);
  assert.equal(match.unmatchedMovements.length, 0);
  // Nada grabado sin confirmación.
  assert.equal((await BankReconciliation.findById(oct._id).lean<any>()).clearedIds.length, 0);
  assert.equal(await BankMovement.countDocuments({ reconciliationId: oct._id }), 0);

  view = await statement.confirmMatches(String(oct._id), { movementIds: match.proposals.map((p) => p.movementId) });
  assert.equal(view.summary.difference, -150);
  view = await statement.noteFromLine(String(oct._id), { line: match.unmatchedLines[0], accountCode: EXPENSE }, ACTOR);
  assert.equal(view.summary.message, "Conciliación cuadrada");
  await rec.closeReconciliation(String(oct._id), {}, ACTOR);

  // Un movimiento conciliado no se anula; tampoco se reabre septiembre con octubre cerrado.
  await assert.rejects(tx.voidTransaction(String(chB._id), { reason: "x" }, ACTOR), /conciliado/);
  await assert.rejects(rec.reopenReconciliation(String(sep._id), { reason: "x" }, ACTOR), /posterior cerrada/);
  await rec.reopenReconciliation(String(oct._id), { reason: "revisión" }, ACTOR);
  assert.equal(await BankMovement.countDocuments({ reconciliationId: oct._id }), 0);

  const pending = await balances.pendingChecks({ date: "2026-10-31", bankAccountId: String(austro._id) });
  assert.equal(pending.count, 1);
  assert.equal(pending.items[0].ageDays, 41);
});

test("cierre con diferencia exige force y motivo", async () => {
  const intl = await bank("Banco Internacional");
  const r = await rec.createReconciliation({ bankAccountId: intl._id, from: "2026-10-01", to: "2026-10-31", statementBalance: 999 }, ACTOR);
  await assert.rejects(rec.closeReconciliation(String(r._id), {}, ACTOR), /no cuadra/);
  await assert.rejects(rec.closeReconciliation(String(r._id), { force: true }, ACTOR), /motivo/);
  const closed = await rec.closeReconciliation(String(r._id), { force: true, reason: "Diferencia en revisión" }, ACTOR);
  assert.equal(closed.status, "cerrada");
});

test("reposición de caja chica con cheque: dos movimientos y un asiento", async () => {
  const gye = await bank("Banco de Guayaquil");
  const caja = await bank("Caja Chica Matriz");
  const t = await tx.createTransaction(
    { type: "TRANSFERENCIA", bankAccountId: gye._id, targetBankAccountId: caja._id, byCheck: true, amount: 10000, date: "2026-10-08", note: "Reposición" },
    ACTOR,
  );
  assert.equal(t.description, "CHEQUE # 1 del Banco de Guayaquil - Caja Chica Matriz - Reposición");
  const movs = await BankMovement.find({ "source.docId": t._id }).sort({ direction: 1 }).lean<any[]>();
  assert.deepEqual(movs.map((m) => [m.type, m.direction, m.amount]), [["TRANSFERENCIA", "in", 10000], ["CHEQUE", "out", 10000]]);
  const all = await balances.cashAndBankBalances("2026-10-31");
  assert.equal(all.items.find((i) => i.name === "Caja Chica Matriz")!.accountingBalance, 10000);
  await assert.rejects(
    tx.createTransaction({ type: "EGRESO_CAJA", bankAccountId: gye._id, date: "2026-10-08", lines: [{ accountCode: EXPENSE, amount: 1 }] }, ACTOR),
    /solo en cajas/,
  );
});
