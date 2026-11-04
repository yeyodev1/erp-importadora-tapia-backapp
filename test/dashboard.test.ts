import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, ACTOR } from "./helpers";
import { Party } from "../src/models/party.model";
import { Product } from "../src/models/product.model";
import { ProductGroup } from "../src/models/productGroup.model";
import { Warehouse } from "../src/models/warehouse.model";
import { getDashboard } from "../src/services/dashboard.service";

let invoices: typeof import("../src/services/invoice.service");
before(async () => {
  await setup();
  const { env } = await import("../src/config/env");
  Object.assign(env, { SRI_P12_BASE64: "", SRI_P12_PASSWORD: "" });
  invoices = await import("../src/services/invoice.service");
});
after(teardown);

test("tablero: ventas del mes y del anterior por bodega y vendedor, serie, tops y secciones por rol", async () => {
  const [gye, uio] = await Promise.all([Warehouse.findOne({ code: "GYE" }).lean<any>(), Warehouse.findOne({ code: "UIO" }).lean<any>()]);
  const [gyeCustomer, uioCustomer] = await Promise.all([
    Party.findOne({ identification: "0912345678001" }).lean<any>(),
    Party.findOne({ identification: "1712345678001" }).lean<any>(),
  ]);
  const group = await ProductGroup.findOne({ name: "ESPECIAS" }).lean<any>();
  const product = await Product.create({ code: "DSH", name: "PRODUCTO TABLERO", groupId: group._id, controlsStock: false, vatRate: 15, prices: [{ list: "GENERAL", price: 1000 }] });
  // Con mínimo y sin stock: cuenta como bajo el mínimo.
  await Product.updateOne({ code: "000002" }, { minQty: 50 });

  const sell = (warehouseId: unknown, partyId: unknown, date: string, qty: number) =>
    invoices.createInvoice({ warehouseId, partyId, date, lines: [{ productId: product._id, qty }] }, ACTOR);
  await sell(gye._id, gyeCustomer._id, "2026-10-05", 10); // RUBEN PALMA, 100.00 + IVA
  await sell(uio._id, uioCustomer._id, "2026-10-20", 3); // VICTOR VERA, 30.00 + IVA
  await sell(gye._id, gyeCustomer._id, "2026-09-15", 5); // mes anterior
  const voided: any = await sell(gye._id, gyeCustomer._id, "2026-10-21", 7);
  await invoices.voidInvoice(String(voided._id), { reason: "Error", date: "2026-10-21" }, ACTOR);

  const d: any = await getDashboard({ role: "admin", name: "Gerencia" }, { month: "2026-10" });
  assert.deepEqual([d.sales.current.sales, d.sales.current.total, d.sales.current.count], [13000, 14950, 2]);
  assert.deepEqual(d.sales.current.byWarehouse.map((w: any) => [w.name, w.sales]), [["Bodega Guayaquil", 10000], ["Bodega Quito", 3000]]);
  assert.deepEqual(d.sales.current.bySeller.map((s: any) => [s.sellerName, s.sales]), [["RUBEN PALMA", 10000], ["VICTOR VERA", 3000]]);
  assert.equal(d.sales.previous.sales, 5000);
  assert.equal(d.sales.series.length, 12);
  assert.deepEqual(d.sales.series.slice(-2), [{ period: "2026-09", sales: 5000, count: 1 }, { period: "2026-10", sales: 13000, count: 2 }]);
  assert.deepEqual(d.topProducts.map((p: any) => [p.code, p.value]), [["DSH", 18000]]);
  assert.deepEqual(d.topCustomers.map((c: any) => [c.identification, c.sales]), [["0912345678001", 15000], ["1712345678001", 3000]]);
  assert.equal(d.lowStock.products, 1);
  assert.equal(d.sriPending.invoices, 3);
  assert.ok(d.receivables.total > 0 && d.receivables.cuadra);

  const seller: any = await getDashboard({ role: "vendedor", name: "VICTOR VERA" }, { month: "2026-10" });
  assert.equal(seller.sales.current.sales, 3000);
  assert.deepEqual(seller.topCustomers.map((c: any) => c.identification), ["1712345678001"]);
  assert.equal(seller.receivables, undefined);
  assert.equal(seller.payables, undefined);

  const bodega: any = await getDashboard({ role: "bodega", name: "Bodega" }, {});
  assert.deepEqual(Object.keys(bodega).filter((k) => !["period", "today", "role"].includes(k)).sort(), ["lowStock", "topProducts"]);
});
