import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { setup, teardown, ACTOR, day } from "./helpers";
import { runInTransaction } from "../src/config/transaction";
import { Party } from "../src/models/party.model";
import { Product } from "../src/models/product.model";
import { Warehouse } from "../src/models/warehouse.model";
import { BankAccount } from "../src/models/bankAccount.model";
import { EmployeeLoan } from "../src/models/employeeLoan.model";
import { JournalEntry } from "../src/models/journalEntry.model";
import { PAYROLL_DEFAULTS } from "../src/models/settings.model";
import { computeLine, loanDeduction, type LineBase } from "../src/services/payrollCalc.service";

let employees: typeof import("../src/services/employee.service");
let payroll: typeof import("../src/services/payroll.service");
before(async () => {
  await setup();
  employees = await import("../src/services/employee.service");
  payroll = await import("../src/services/payroll.service");
});
after(teardown);

const base = (over: Partial<LineBase> = {}): LineBase => ({
  employeeId: new Types.ObjectId(), partyId: new Types.ObjectId(), name: "PRUEBA", identification: "0911111110",
  department: "ventas", position: "Vendedor", hireDate: day("2026-03-01"), salary: 100000, reserveFundMonthly: true, ...over,
});
const edits = { days: 30, extras: 5000, commissions: 10000, otherDeductions: 0 };

test("cálculo: 9.45 %, 12.15 % patronal, décimos, vacaciones y fondo de reserva solo tras un año", () => {
  const l = computeLine(base(), edits, [], PAYROLL_DEFAULTS, "2026-11");
  assert.equal(l.iessBase, 115000);
  assert.equal(l.iessPersonal, 10868, "9.45 % de 1,150.00 = 108.675");
  assert.equal(l.employer.iess, 12823, "11.15 %");
  assert.equal(l.employer.secapIece, 1150, "0.5 % SECAP + 0.5 % IECE");
  assert.equal(l.employer.iess + l.employer.secapIece, 13973, "12.15 % en total");
  assert.equal(l.employer.thirteenth, 9583, "ingresos / 12");
  assert.equal(l.employer.fourteenth, 3917, "SBU 470 / 12");
  assert.equal(l.employer.vacation, 4792, "ingresos / 24");
  assert.equal(l.employer.reserveFund, 0, "menos de un año: sin fondo de reserva");
  assert.equal(l.net, 115000 - 10868);

  const senior = computeLine(base({ hireDate: day("2024-01-10") }), edits, [], PAYROLL_DEFAULTS, "2026-11");
  assert.equal(senior.employer.reserveFund, 9580, "8.33 % de 1,150.00");
  assert.equal(senior.reserveFundPaid, 9580, "mensualizado: va en el rol");
  assert.equal(senior.net, 115000 + 9580 - 10868);
  const accrued = computeLine(base({ hireDate: day("2024-01-10"), reserveFundMonthly: false }), edits, [], PAYROLL_DEFAULTS, "2026-11");
  assert.equal(accrued.reserveFundPaid, 0, "acumulado: no sale en el neto");
  const anniversary = computeLine(base({ hireDate: day("2025-11-16") }), edits, [], PAYROLL_DEFAULTS, "2026-11");
  assert.equal(anniversary.employer.reserveFund, 4790, "cumple el año el 16: 15 días");

  const half = computeLine(base(), { ...edits, days: 15, extras: 0, commissions: 0 }, [], PAYROLL_DEFAULTS, "2026-11");
  assert.equal(half.salaryEarned, 50000);
  assert.equal(half.employer.fourteenth, 1958, "décimo cuarto proporcional a los días");
});

test("cálculo: la cuota del préstamo no pasa del saldo; el del IESS sin saldo descuenta la cuota", () => {
  const id = new Types.ObjectId();
  assert.equal(loanDeduction({ loanId: id, type: "interno", installment: 20000, balance: 5000 }).amount, 5000);
  assert.equal(loanDeduction({ loanId: id, type: "interno", installment: 20000, balance: 50000 }).amount, 20000);
  assert.deepEqual(loanDeduction({ loanId: id, type: "quirografario", installment: 7000, balance: null }), { loanId: id, type: "quirografario", amount: 7000, tracksBalance: false });
  const l = computeLine(base(), edits, [{ loanId: id, type: "hipotecario", installment: 3000, balance: 1000 }], PAYROLL_DEFAULTS, "2026-11");
  assert.equal(l.loanTotals.hipotecario, 1000);
  assert.equal(l.totalDeductions, 10868 + 1000);
});

let ruben: any, ana: any;

test("empleado: valida la cédula y se ata al tercero de la misma cédula o crea uno", async () => {
  const data = { firstName: "Ruben", lastName: "Palma", hireDate: "2024-01-10", department: "ventas", salary: 100000 };
  await assert.rejects(employees.employees.create({ ...data, identification: "0911111111" }), /dígito verificador/);
  await assert.rejects(employees.employees.create({ ...data, identification: "12345" }), /10 dígitos/);

  const existing = await Party.create({ identification: "0911111110", idType: "05", name: "RUBEN PALMA LOPEZ", isSupplier: true });
  ruben = await employees.employees.create({ ...data, identification: "0911111110", sellerName: "RUBEN PALMA", commissionRate: 2 });
  assert.equal(String(ruben.partyId), String(existing._id), "reusa el tercero");
  const linked = await Party.findById(existing._id).lean<any>();
  assert.equal(linked.isEmployee, true);
  assert.equal(linked.isSupplier, true, "no pierde lo que ya era");

  ana = await employees.employees.create({ firstName: "Ana", lastName: "Mora", identification: "1710034065", hireDate: "2026-11-16", department: "administracion", salary: 60000 });
  const created = await Party.findById(ana.partyId).lean<any>();
  assert.deepEqual([created.identification, created.idType, created.name, created.isEmployee], ["1710034065", "05", "MORA ANA", true]);
  await assert.rejects(employees.employees.create({ ...data, identification: "1710034065" }), /Ya hay un empleado/);
  const updated: any = await employees.employees.update(String(ana._id), { identification: "0926687856", position: "Contadora" });
  assert.equal(updated.identification, "1710034065", "la cédula no cambia");
});

test("rol: prellena comisiones, aprueba con asiento cuadrado, rebaja préstamos y al anular los devuelve", async () => {
  // Cobro de noviembre a un cliente de RUBEN PALMA: 2 % de comisión.
  const inventory = await import("../src/services/inventoryCore.service");
  const invoices = await import("../src/services/invoice.service");
  const receipts = await import("../src/services/receipt.service");
  const gye = await Warehouse.findOne({ code: "GYE" }).lean<any>();
  const achiote = await Product.findOne({ code: "000002" }).lean<any>();
  const customer = await Party.findOne({ identification: "0912345678001" }).lean<any>();
  const bank = await BankAccount.findOne({ name: "Banco Pichincha" }).lean<any>();
  await runInTransaction((s) =>
    inventory.applyMovement({ warehouseId: gye._id, date: day("2026-10-01"), type: "INGRESO_COMPRA", source: { module: "test", docType: "TEST", docId: null, docNumber: "" }, lines: [{ productId: achiote._id, qty: 100, unitCost: 1 }] }, ACTOR, s),
  );
  const inv = await invoices.createInvoice({ warehouseId: gye._id, partyId: customer._id, date: "2026-11-02", lines: [{ productId: achiote._id, qty: 100, unitPrice: 500 }] }, ACTOR);
  await receipts.createReceipt({ partyId: customer._id, date: "2026-11-03", method: "DEPOSITO", bankAccountId: bank._id, amount: 50000, applications: [{ invoiceId: inv._id, amount: 50000 }] }, ACTOR);

  const internal: any = await employees.loans.create({ employeeId: ruben._id, type: "interno", date: "2026-10-01", total: 30000, installment: 20000 });
  assert.equal(internal.balance, 30000);
  await employees.loans.create({ employeeId: ana._id, type: "quirografario", date: "2026-11-01", installment: 5000 });

  const draft: any = await payroll.generate({ period: "2026-11" }, ACTOR);
  const lineOf = (p: any, e: any) => p.lines.find((l: any) => String(l.employeeId) === String(e._id));
  assert.equal(lineOf(draft, ruben).commissions, 1000, "2 % de 500.00 cobrados");
  assert.equal(lineOf(draft, ruben).loanTotals.interno, 20000);
  assert.equal(lineOf(draft, ana).days, 15, "ingresó el 16");
  assert.equal(lineOf(draft, ana).loanTotals.quirografario, 5000);
  await assert.rejects(payroll.generate({ period: "2026-11" }, ACTOR), /Ya hay un rol/);

  const edited: any = await payroll.update(String(draft._id), { lines: [{ employeeId: ruben._id, extras: 5000, otherDeductions: 2000 }] });
  const r = lineOf(edited, ruben);
  assert.deepEqual([r.extras, r.commissions, r.otherDeductions, r.iessBase], [5000, 1000, 2000, 106000]);
  await assert.rejects(payroll.update(String(draft._id), { lines: [{ employeeId: ruben._id, days: 31 }] }), /Días inválidos/);

  const approved: any = await payroll.approve(String(draft._id), ACTOR);
  assert.equal(approved.status, "aprobado");
  const entry = await JournalEntry.findById(approved.journalEntryId).lean<any>();
  assert.equal(entry.type, "NOMINA");
  assert.equal(entry.totalDebit, entry.totalCredit);
  const sumOf = (code: string, side: "debit" | "credit") => entry.lines.filter((l: any) => l.accountCode === code).reduce((a: number, l: any) => a + l[side], 0);
  assert.equal(sumOf("5.2.01.01.01.002", "debit"), 5000, "extras de ventas a Sobretiempos");
  assert.equal(sumOf("1.1.02.08.02.001", "credit"), 20000, "cuota del préstamo interno");
  assert.equal(sumOf("2.1.07.04.01.001", "credit"), approved.totals.net, "neto por pagar");
  assert.equal(sumOf("2.1.07.03.01.001", "credit"), r.iessPersonal + lineOf(edited, ana).iessPersonal);
  assert.equal(entry.totalDebit, approved.totals.employerCost, "el gasto es el costo de la empresa");
  assert.equal((await EmployeeLoan.findById(internal._id).lean<any>()).balance, 10000);
  await assert.rejects(payroll.approve(String(draft._id), ACTOR), /ya no está en borrador/);

  const december: any = await payroll.generate({ period: "2026-12" }, ACTOR);
  assert.equal(lineOf(december, ruben).loanTotals.interno, 10000, "la cuota se corta en el saldo");
  await payroll.voidPayroll(String(december._id), { reason: "Prueba" }, ACTOR);

  await assert.rejects(payroll.voidPayroll(String(draft._id), {}, ACTOR), /motivo/);
  const voided: any = await payroll.voidPayroll(String(draft._id), { reason: "Error en extras" }, ACTOR);
  assert.equal(voided.status, "anulado");
  assert.equal((await JournalEntry.findById(approved.journalEntryId).lean<any>()).status, "anulado");
  const reversal = await JournalEntry.findOne({ reversalOf: approved.journalEntryId }).lean<any>();
  assert.equal(reversal.totalDebit, entry.totalDebit);
  assert.equal((await EmployeeLoan.findById(internal._id).lean<any>()).balance, 30000, "el saldo vuelve");
  assert.ok(await payroll.generate({ period: "2026-11" }, ACTOR), "anulado, se puede generar de nuevo");
});

test("configuración: las claves de nómina salen con su cuenta por defecto y el SBU se cambia validado", async () => {
  const settings = await import("../src/services/settings.service");
  const { Settings } = await import("../src/models/settings.model");
  await Settings.updateOne({ _id: "main" }, { $unset: { "accounts.payrollNetPayable": 1, payroll: 1 } });
  const s: any = await settings.get();
  assert.equal(s.accounts.payrollNetPayable, "2.1.07.04.01.001", "base vieja sin la clave: va el valor por defecto");
  assert.equal(s.payroll.sbu, 47000);
  assert.equal((await settings.update({ payroll: { sbu: 48200 } }) as any).payroll.sbu, 48200);
  await assert.rejects(settings.update({ payroll: { sbu: 482.5 } }), /inválido/);
  await assert.rejects(settings.update({ payroll: { iessPersonalRate: 120 } }), /inválido/);
});
