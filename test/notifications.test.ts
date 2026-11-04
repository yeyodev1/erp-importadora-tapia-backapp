import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { setup, teardown, ACTOR, day } from "./helpers";
import { CustomerReceipt } from "../src/models/customerReceipt.model";
import { Party } from "../src/models/party.model";
import { PaymentApproval } from "../src/models/paymentApproval.model";
import { Product } from "../src/models/product.model";
import { ProductGroup } from "../src/models/productGroup.model";
import { SalesInvoice } from "../src/models/salesInvoice.model";
import { StockBalance } from "../src/models/stockBalance.model";
import { Warehouse } from "../src/models/warehouse.model";
import { todayStr } from "../src/services/ledgerReports.service";

let invoices: typeof import("../src/services/invoice.service");
let listNotifications: typeof import("../src/services/notifications.service").listNotifications;
before(async () => {
  await setup();
  const { env } = await import("../src/config/env");
  Object.assign(env, { SRI_P12_BASE64: "", SRI_P12_PASSWORD: "" });
  invoices = await import("../src/services/invoice.service");
  ({ listNotifications } = await import("../src/services/notifications.service"));
});
after(teardown);

const ids = (list: { id: string }[]) => list.map((n) => n.id).sort();

test("avisos: se calculan según los datos y cada rol ve solo lo suyo", async () => {
  const today = todayStr();
  const ago = (days: number) => day(new Date(Date.parse(today) - days * 86_400_000).toISOString().slice(0, 10));
  const gye = await Warehouse.findOne({ code: "GYE" }).lean<any>();
  const customer = await Party.findOne({ identification: "0912345678001" }).lean<any>();
  const group = await ProductGroup.findOne({ name: "ESPECIAS" }).lean<any>();
  const product = await Product.create({ code: "NTF", name: "PRODUCTO AVISOS", groupId: group._id, controlsStock: false, vatRate: 15, prices: [{ list: "GENERAL", price: 1000 }] });
  const sell = () => invoices.createInvoice({ warehouseId: gye._id, partyId: customer._id, date: today, lines: [{ productId: product._id, qty: 10 }] }, ACTOR) as Promise<any>;

  // Sin p12 las facturas quedan "sin_firma"; una devuelta por el SRI y dos vencidas (45 y 120 días).
  const [a, b, c] = [await sell(), await sell(), await sell()];
  await SalesInvoice.updateOne({ _id: a._id }, { sriStatus: "devuelto", dueDate: ago(45) });
  await SalesInvoice.updateOne({ _id: b._id }, { dueDate: ago(120) });
  await SalesInvoice.updateOne({ _id: c._id }, { sriStatus: "autorizado" });
  await Product.updateOne({ code: "000002" }, { minQty: 50 });
  await StockBalance.collection.insertOne({ productId: new Types.ObjectId(), warehouseId: gye._id, qty: -3, avgCost: 0 });
  await CustomerReceipt.collection.insertMany([
    { number: 9001, method: "CHEQUE_POSFECHADO", status: "vigente", amount: 5000, check: { status: "en_cartera", dueDate: day(today) } },
    { number: 9002, method: "CHEQUE_POSFECHADO", status: "vigente", amount: 7000, check: { status: "en_cartera", dueDate: new Date(day(today).getTime() + 3 * 86_400_000) } },
  ]);
  await PaymentApproval.collection.insertOne({ number: 1, status: "pendiente", total: 20000, lines: [], updatedAt: new Date() });

  const all = await listNotifications("admin");
  const by = Object.fromEntries(all.map((n) => [n.id, n]));
  assert.equal(by["sri-invoices-danger"].count, 1);
  assert.equal(by["sri-invoices-warning"].count, 1);
  assert.equal(by["sri-invoices-danger"].link, "/facturacion/facturas?sriStatus=devuelto");
  assert.equal(by["cxc-overdue-30"].count, 1);
  assert.equal(by["cxc-overdue-90"].level, "danger");
  assert.match(by["cxc-overdue-90"].message, /\$115\.00/);
  assert.equal(by["checks-today"].count, 1);
  assert.equal(by["checks-week"].count, 1);
  assert.equal(by["stock-negative"].count, 1);
  assert.equal(by["stock-low"].count, 1);
  assert.equal(by["cxp-approved"].count, 1);
  assert.ok(by["sri-test-environment"], "el demo está en ambiente de pruebas");
  assert.ok(all.some((n) => n.id.startsWith("period-open-")), "sin meses cerrados: el anterior sigue abierto");
  // Primero lo rojo, luego lo ámbar y al final lo informativo.
  const order = all.map((n) => ["danger", "warning", "info", "success"].indexOf(n.level));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));

  assert.deepEqual(ids(await listNotifications("bodega")), ["stock-low", "stock-negative"]);
  assert.deepEqual(ids(await listNotifications("cartera")), ["checks-today", "checks-week", "cxc-overdue-30", "cxc-overdue-90"]);
  assert.deepEqual(ids(await listNotifications("facturacion")), ["sri-invoices-danger", "sri-invoices-warning"]);
  assert.deepEqual(await listNotifications("vendedor"), []);
  assert.deepEqual(ids(await listNotifications("contabilidad")), ids(all));
});
