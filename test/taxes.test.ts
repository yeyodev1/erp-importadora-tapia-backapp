import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { XMLParser } from "fast-xml-parser";
import { setup, teardown, ACTOR, day } from "./helpers";
import { runInTransaction } from "../src/config/transaction";
import { BankAccount } from "../src/models/bankAccount.model";
import { Party } from "../src/models/party.model";
import { Product } from "../src/models/product.model";
import { SalesInvoice } from "../src/models/salesInvoice.model";
import { ProductGroup } from "../src/models/productGroup.model";
import { Warehouse } from "../src/models/warehouse.model";
import { WithholdingCode } from "../src/models/withholdingCode.model";
import * as accounting from "../src/services/accounting.service";
import { amount, atsXml } from "../src/services/atsXml.service";

// Los services que emiten al SRI leen env.ts (exige DB_URI): se importan tras levantar la base.
let invoices: typeof import("../src/services/invoice.service");
let creditNotes: typeof import("../src/services/creditNote.service");
let receipts: typeof import("../src/services/receipt.service");
let withholdings: typeof import("../src/services/withholding.service");
let purchases: typeof import("../src/services/purchaseInvoice.service");
let ats: typeof import("../src/services/ats.service");
let reconciliation: typeof import("../src/services/taxReconciliation.service");
before(async () => {
  await setup();
  const { env } = await import("../src/config/env");
  Object.assign(env, { SRI_P12_BASE64: "", SRI_P12_PASSWORD: "" });
  invoices = await import("../src/services/invoice.service");
  creditNotes = await import("../src/services/creditNote.service");
  receipts = await import("../src/services/receipt.service");
  withholdings = await import("../src/services/withholding.service");
  purchases = await import("../src/services/purchaseInvoice.service");
  ats = await import("../src/services/ats.service");
  reconciliation = await import("../src/services/taxReconciliation.service");
});
after(teardown);

const PERIOD = "2026-10";
const EXPENSE = "5.2.02.01.01.001";
const CASH = "1.1.01.01.01.001";

test("amount(): centavos a 2 decimales sin floats", () => {
  assert.deepEqual([amount(0), amount(5), amount(12345), amount(-150), amount(100000001)], ["0.00", "0.05", "123.45", "-1.50", "1000000.01"]);
});

test("preparación: 2 facturas, NC, cobro con retención y compra con retención en octubre", async () => {
  const gye = await Warehouse.findOne({ code: "GYE" }).lean<any>();
  const customer = await Party.findOne({ identification: "0912345678001" }).lean<any>();
  const supplier = await Party.findOne({ identification: "0990000000001" }).lean<any>();
  const especias = await ProductGroup.findOne({ name: "ESPECIAS" }).lean<any>();
  const [p15, p0] = await Product.insertMany([
    { code: "T15", name: "SERVICIO GRAVADO", groupId: especias._id, controlsStock: false, vatRate: 15, prices: [{ list: "GENERAL", price: 1000 }] },
    { code: "T0", name: "ESPECIA TARIFA 0", groupId: especias._id, controlsStock: false, vatRate: 0, prices: [{ list: "GENERAL", price: 2000 }] },
  ]);
  const a: any = await invoices.createInvoice({ warehouseId: gye._id, partyId: customer._id, date: "2026-10-10", lines: [{ productId: p15._id, qty: 10 }, { productId: p0._id, qty: 5 }] }, ACTOR);
  const b: any = await invoices.createInvoice({ warehouseId: gye._id, partyId: customer._id, date: "2026-10-12", lines: [{ productId: p15._id, qty: 2 }] }, ACTOR);
  assert.deepEqual([a.subtotalVat, a.subtotal0, a.vat, a.total], [10000, 10000, 1500, 21500]);
  assert.equal(b.total, 2300);
  await creditNotes.createCreditNote({ invoiceId: a._id, date: "2026-10-15", reason: "Descuento", returnsStock: false, lines: [{ productId: p15._id, qty: 1 }] }, ACTOR);
  const pichincha = await BankAccount.findOne({ name: "Banco Pichincha" }).lean<any>();
  await receipts.createReceipt({ partyId: customer._id, date: "2026-10-20", method: "DEPOSITO", bankAccountId: pichincha._id, amount: 5000, applications: [{ invoiceId: a._id, amount: 5000 }] }, ACTOR);
  const w: any = await withholdings.createWithholding(
    { invoiceId: a._id, date: "2026-10-20", voucherNumber: "001-001-000000321", authorization: "9".repeat(49), lines: [{ tax: "renta", rate: 1.75 }, { tax: "iva", rate: 10 }] },
    ACTOR,
  );
  assert.equal(w.total, 350 + 150);

  const code = async (tax: string, c: string) => (await WithholdingCode.findOne({ tax, code: c }).lean<any>())._id;
  const inv: any = await purchases.createInvoice(
    {
      supplierId: supplier._id, docType: "01", series: "001-001", number: "777", date: "2026-10-18", taxSupport: "01", authorization: "1".repeat(49),
      expenseLines: [{ accountCode: EXPENSE, base0: 5000, baseVat: 20000 }],
      withholdings: [{ codeId: await code("renta", "312"), base: 20000, rate: 1.75 }, { codeId: await code("iva", "725"), base: 3000, rate: 30 }],
    },
    ACTOR,
  );
  assert.deepEqual([inv.vat, inv.withholdingTotal, inv.withholding.number], [3000, 1250, "001-001-000000001"]);
});

test("ATS: compra con su detalleAir y ventas agrupadas por cliente con su retención", async () => {
  const data = await ats.buildAts(PERIOD);
  assert.equal(data.compras.length, 1);
  const c: any = data.compras[0];
  assert.deepEqual(
    [c.codSustento, c.tpIdProv, c.idProv, c.tipoComprobante, c.establecimiento, c.puntoEmision, c.secuencial, c.baseImponible, c.baseImpGrav, c.montoIva, c.valorRetBienes, c.valRetBien10],
    ["01", "01", "0990000000001", "01", "001", "001", "000000777", 5000, 20000, 3000, 900, 0],
  );
  assert.deepEqual(c.air, [{ codRetAir: "312", baseImpAir: 20000, porcentajeAir: 1.75, valRetAir: 350 }]);
  assert.deepEqual([c.retencion.estabRetencion1, c.retencion.ptoEmiRetencion1, c.retencion.secRetencion1], ["001", "001", "000000001"]);

  assert.equal(data.ventas.length, 2);
  const [nc, fact] = data.ventas; // ordenadas por cliente y tipo: 04 antes que 18
  assert.deepEqual(
    [fact.tipoComprobante, fact.idCliente, fact.numeroComprobantes, fact.baseImponible, fact.baseImpGrav, fact.montoIva, fact.valorRetRenta, fact.valorRetIva, fact.formasDePago],
    ["18", "0912345678001", 2, 10000, 12000, 1800, 350, 150, ["20"]],
  );
  assert.deepEqual([nc.tipoComprobante, nc.numeroComprobantes, nc.baseImpGrav, nc.montoIva, nc.valorRetRenta], ["04", 1, 1000, 150, 0]);
  assert.deepEqual(data.ventasEstablecimiento, [{ codEstab: "001", ventasEstab: 21000, ivaComp: 0 }, { codEstab: "002", ventasEstab: 0, ivaComp: 0 }]);
  assert.equal(data.informante.totalVentas, 21000);
  assert.equal(data.informante.numEstabRuc, "002");
  assert.ok(data.warnings.some((w) => w.startsWith("parteRel")));
  assert.ok(data.warnings.some((w) => w.includes("sin_firma")));
});

test("ATS XML: totales, montos con 2 decimales y orden de la ficha", async () => {
  const xml = atsXml(await ats.buildAts(PERIOD));
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  const iva = new XMLParser({ parseTagValue: false }).parse(xml).iva;
  assert.deepEqual([iva.TipoIDInformante, iva.IdInformante, iva.Anio, iva.Mes, iva.totalVentas, iva.codigoOperativo], ["R", "0993014214001", "2026", "10", "210.00", "IVA"]);
  const dc = iva.compras.detalleCompras;
  assert.deepEqual([dc.fechaEmision, dc.baseImponible, dc.baseImpGrav, dc.montoIva, dc.valorRetBienes, dc.parteRel], ["18/10/2026", "50.00", "200.00", "30.00", "9.00", "NO"]);
  assert.deepEqual(dc.air.detalleAir, { codRetAir: "312", baseImpAir: "200.00", porcentajeAir: "1.75", valRetAir: "3.50" });
  assert.equal(dc.pagoExterior.pagoLocExt, "01");
  assert.equal(dc.formasDePago.formaPago, "20");
  const [v04, v18] = iva.ventas.detalleVentas;
  assert.deepEqual([v18.tipoEmision, v18.numeroComprobantes, v18.baseImpGrav, v18.montoIva, v18.valorRetRenta, v18.valorRetIva], ["E", "2", "120.00", "18.00", "3.50", "1.50"]);
  assert.equal(v04.tipoComprobante, "04");
  assert.equal(v04.formasDePago, undefined);
  assert.deepEqual(iva.ventasEstablecimiento.ventaEst.map((v: any) => v.ventasEstab), ["210.00", "0.00"]);
  const keys = Object.keys(dc);
  assert.ok(keys.indexOf("montoIva") < keys.indexOf("valRetBien10") && keys.indexOf("valRetServ100") < keys.indexOf("totbasesImpReemb"));
  assert.ok(keys.indexOf("air") < keys.indexOf("estabRetencion1"));
});

test("ATS: factura anulada sale de ventas y entra en anulados solo si el SRI la autorizó", async () => {
  const gye = await Warehouse.findOne({ code: "GYE" }).lean<any>();
  const customer = await Party.findOne({ identification: "0912345678001" }).lean<any>();
  const p15 = await Product.findOne({ code: "T15" }).lean<any>();
  const sell = () => invoices.createInvoice({ warehouseId: gye._id, partyId: customer._id, date: "2026-10-25", lines: [{ productId: p15._id, qty: 4 }] }, ACTOR) as Promise<any>;
  const [authorized, never] = [await sell(), await sell()];
  await SalesInvoice.updateOne({ _id: authorized._id }, { sriStatus: "autorizado", authorizationNumber: "2".repeat(49) });
  for (const inv of [authorized, never]) await invoices.voidInvoice(String(inv._id), { reason: "Error de digitación", date: "2026-10-25" }, ACTOR);

  const data = await ats.buildAts(PERIOD);
  assert.equal(data.informante.totalVentas, 21000);
  assert.deepEqual(data.anulados, [
    { tipoComprobante: "01", establecimiento: "001", puntoEmision: "001", secuencialInicio: authorized.sequential, secuencialFin: authorized.sequential, autorizacion: "2".repeat(49) },
  ]);
  assert.ok(data.warnings.some((w) => w.includes(never.number) && w.includes("no se reporta")));
});

test("cuadre mensual: documentos = mayor en todos los conceptos; un asiento manual al IVA ventas lo descuadra", async () => {
  const ok: any = await reconciliation.monthlyReconciliation(PERIOD);
  const by = (r: any, k: string) => r.items.find((i: any) => i.concepto === k);
  assert.deepEqual(
    ok.items.map((i: any) => [i.concepto, i.valorDocumentos, i.cuadra]),
    [["ventasNetas", 21000, true], ["ivaVentas", 1650, true], ["ivaCompras", 3000, true], ["retRentaRecibidas", 350, true], ["retIvaRecibidas", 150, true], ["retRentaEmitidas", 350, true], ["retIvaEmitidas", 900, true]],
  );
  assert.equal(ok.cuadra, true);
  const casillero = (n: string) => ok.form104.casilleros.find((c: any) => c.casillero === n).valor;
  assert.equal(ok.form104.referencial, true);
  assert.deepEqual([casillero("411"), casillero("413"), casillero("421"), casillero("520"), casillero("609"), casillero("725")], [11000, 10000, 1650, 3000, 150, 900]);

  await runInTransaction(async (s) =>
    accounting.postEntry(
      { date: day("2026-10-31"), type: "DIARIO", description: "Ajuste manual", lines: [{ accountCode: await accounting.mappedAccount("vatSales", s), debit: 100 }, { accountCode: CASH, credit: 100 }] },
      ACTOR,
      s,
    ),
  );
  const bad: any = await reconciliation.monthlyReconciliation(PERIOD);
  assert.equal(bad.cuadra, false);
  assert.deepEqual([by(bad, "ivaVentas").cuadra, by(bad, "ivaVentas").valorContable, by(bad, "ivaVentas").diferencia], [false, 1550, 100]);
  assert.equal(by(bad, "ivaVentas").byEntryType.DIARIO, -100);
  assert.equal(by(bad, "ivaCompras").cuadra, true);
});
