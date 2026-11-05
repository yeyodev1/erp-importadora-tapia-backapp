import { ClientSession, Types } from "mongoose";
import { runInTransaction } from "../config/transaction";
import { CustomError } from "../errors/customError.error";
import { ArMovement } from "../models/arMovement.model";
import { ImportBatch, IRestore } from "../models/importBatch.model";
import { Party } from "../models/party.model";
import { Product } from "../models/product.model";
import { SalesInvoice } from "../models/salesInvoice.model";
import { parseDay } from "../utils/dates";
import { formatCents, sum } from "../utils/money";
import * as accounting from "./accounting.service";
import type { Actor } from "./accounting.service";
import { applyMovement } from "./inventoryCore.service";
import { trialBalance } from "./ledgerReports.service";
import { buildPlan, MacioPlan } from "./migrationPlan.service";
import { presentPlan } from "./migrationPreview.service";
import { aging } from "./receivablesReport.service";
import { todayEc } from "./salesCommon.service";
import * as sequence from "./sequence.service";

/**
 * Importa Macio en UNA transacción y un ImportBatch: clientes, productos,
 * stock inicial a costo 0 y la cartera abierta como saldos iniciales
 * (SalesInvoice isOpening) con un asiento resumen. Al final verifica que la
 * cartera por edades suba exactamente lo importado y que el balance cuadre.
 */
export async function nextBatchNumber(session: ClientSession) {
  return `MIG-${String(await sequence.next("migracion", session)).padStart(6, "0")}`;
}

/** Completa solo lo vacío de una ficha que ya existía y anota cómo estaba. */
function fillBlanks(existing: any, wanted: Record<string, unknown>): IRestore | null {
  const previous: Record<string, unknown> = {};
  const applied: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(wanted)) {
    const current = path.split(".").reduce((o, k) => o?.[k], existing);
    const blank = current === undefined || current === null || current === "" || current === 0 || current === false;
    if (blank && value !== "" && value !== 0 && value !== undefined) {
      previous[path] = current ?? null;
      applied[path] = value;
    }
  }
  return Object.keys(applied).length ? { model: "Party", id: existing._id, previous, applied } : null;
}

async function importParties(plan: MacioPlan, batchId: Types.ObjectId, session: ClientSession) {
  const ids = new Map<string, Types.ObjectId>();
  const created: any[] = [];
  const restores: IRestore[] = [];
  for (const c of plan.clients) {
    const creditDays = plan.creditDays.get(c.identification) ?? 0;
    const existing = plan.existingParties.get(c.identification);
    if (existing) {
      ids.set(c.identification, existing._id);
      const r = fillBlanks(existing, {
        isCustomer: true, address: c.address, phone: c.phone, email: c.email,
        "customer.sellerName": c.sellerName, "customer.sellerCode": c.sellerCode, "customer.creditDays": creditDays,
      });
      if (r) restores.push(r);
      continue;
    }
    const _id = new Types.ObjectId();
    ids.set(c.identification, _id);
    created.push({
      _id, identification: c.identification, idType: c.idType, name: c.name, address: c.address, phone: c.phone, email: c.email,
      isCustomer: true, customer: { sellerName: c.sellerName, sellerCode: c.sellerCode, creditDays }, importBatchId: batchId,
    });
  }
  // insertMany/bulkWrite: miles de fichas en una sola ida a la base, dentro del tiempo de la transacción.
  if (created.length) await Party.insertMany(created, { session });
  if (restores.length) {
    await Party.bulkWrite(restores.map((r) => ({ updateOne: { filter: { _id: r.id }, update: { $set: r.applied } } })), { session });
  }
  return { ids, created: created.length, updated: restores.length, restores };
}

async function importProducts(plan: MacioPlan, batchId: Types.ObjectId, session: ClientSession) {
  const ids = new Map<string, Types.ObjectId>();
  const created: any[] = [];
  for (const p of plan.products) {
    if (p.existing) {
      ids.set(p.code, p.existing._id);
      continue;
    }
    const _id = new Types.ObjectId();
    ids.set(p.code, _id);
    created.push({
      _id, code: p.code, name: p.name, groupId: plan.groups.get(p.group)._id, unit: p.unit,
      purchaseUnit: { name: p.unit, factor: 1 }, vatRate: 0,
      notes: `Migrado de Macio (código ${p.macioCode}). Grupo sugerido; factor pendiente; costo pendiente de Macio.`,
      importBatchId: batchId,
    });
  }
  if (created.length) await Product.insertMany(created, { session });
  return { ids, created: created.length };
}

/** Stock de Macio a costo 0: INVENTARIO_INICIAL sin asiento (valor 0) hasta que lleguen los costos. */
async function importStock(plan: MacioPlan, productIds: Map<string, Types.ObjectId>, batch: { _id: Types.ObjectId; number: string }, date: Date, actor: Actor, session: ClientSession) {
  let lines = 0;
  for (const w of ["GYE", "UIO"]) {
    const items = plan.products.flatMap((p) => p.stock.filter((s) => s.warehouse === w).map((s) => ({ productId: productIds.get(p.code)!, qty: s.qty, unitCost: 0 })));
    if (!items.length) continue;
    await applyMovement(
      {
        warehouseId: plan.warehouses.get(w)._id, date, type: "INVENTARIO_INICIAL",
        source: { module: "migracion", docType: "SALDO_INICIAL_MACIO", docId: batch._id, docNumber: `${batch.number} costo pendiente de Macio` },
        lines: items,
      },
      actor,
      session,
    );
    lines += items.length;
  }
  return lines;
}

/**
 * Cada factura abierta = un saldo inicial con su número, fecha y vencimiento
 * originales. Su libro de cartera: FACTURA por el total y, si tuvo abonos en
 * Macio, un COBRO por lo abonado, ambos en la fecha de la factura; así el
 * saldo a cualquier corte es el saldo de Macio.
 */
async function importReceivables(plan: MacioPlan, partyIds: Map<string, Types.ObjectId>, batch: { _id: Types.ObjectId; number: string }, actor: Actor, session: ClientSession) {
  const invoices: any[] = [];
  const movements: any[] = [];
  for (const i of plan.invoices) {
    const _id = new Types.ObjectId();
    const partyId = partyIds.get(i.client.identification)!;
    const warehouse = plan.warehouses.get(i.warehouse);
    const source = { docType: "SALDO_INICIAL", docId: batch._id, docNumber: i.number };
    invoices.push({
      _id, number: i.number, establishment: warehouse.establishment, emissionPoint: warehouse.emissionPoint, sequential: i.sequential,
      warehouseId: warehouse._id, partyId,
      customer: { identification: i.client.identification, idType: i.client.idType, name: i.client.name, address: i.client.address, email: i.client.email, customerType: "", parish: "" },
      sellerName: i.client.sellerName, date: i.date, creditDays: i.creditDays, dueDate: i.dueDate,
      notes: `Saldo inicial migrado de Macio (${batch.number}, trc_codigo ${i.trcCode}). Total original $${formatCents(i.total)}, abonado $${formatCents(i.paid)}.`,
      lines: [], subtotal0: i.total, total: i.total, balance: i.balance, sriStatus: "no_aplica",
      isOpening: true, importBatchId: batch._id, createdBy: actor,
    });
    movements.push({ invoiceId: _id, partyId, date: i.date, kind: "FACTURA", amount: i.total, description: `Saldo inicial Macio ${i.number}`, source });
    if (i.paid > 0) movements.push({ invoiceId: _id, partyId, date: i.date, kind: "COBRO", amount: -i.paid, description: "Abonos registrados en Macio antes de la migración", source });
  }
  // Sin addAr: se graba `balance` ya final y sus líneas juntas (mismo invariante, en lote para no agotar la transacción).
  if (invoices.length) {
    await SalesInvoice.insertMany(invoices, { session });
    await ArMovement.insertMany(movements, { session });
  }
  return invoices;
}

export async function applyMacio(data: unknown, actor: Actor) {
  const cutoffText = todayEc();
  const agingBefore = (await aging({ cutoff: cutoffText })).totals.total;

  const batch = await runInTransaction(async (session) => {
    const plan = await buildPlan(data, session);
    if (plan.blockers.length) throw new CustomError(`No se puede importar: ${plan.blockers.join(" ")}`, 409);
    const cutoff = parseDay(cutoffText);
    const _id = new Types.ObjectId();
    const number = await nextBatchNumber(session);
    const ref = { _id, number };

    const parties = await importParties(plan, _id, session);
    const products = await importProducts(plan, _id, session);
    const stockLines = await importStock(plan, products.ids, ref, cutoff, actor, session);
    const invoices = await importReceivables(plan, parties.ids, ref, actor, session);
    const receivables = sum(invoices.map((i) => i.balance));

    let journalEntryId: Types.ObjectId | null = null;
    if (receivables > 0) {
      const entry = await accounting.postEntry(
        {
          date: cutoff, type: "DIARIO", description: `Saldo inicial de cartera migrado de Macio (${invoices.length} facturas, ${number})`,
          source: { module: "migracion", docType: "SALDO_INICIAL_CXC", docId: _id, docNumber: number },
          lines: [
            { accountCode: await accounting.mappedAccount("customers", session), debit: receivables, description: "Cartera abierta de Macio" },
            { accountCode: await accounting.mappedAccount("openingBalance", session), credit: receivables, description: "Saldo inicial" },
          ],
        },
        actor,
        session,
      );
      journalEntryId = entry._id;
      await SalesInvoice.updateMany({ importBatchId: _id }, { journalEntryId }, { session });
    }

    const preview = presentPlan(plan);
    const [doc] = await ImportBatch.create(
      [{
        _id, number, source: "macio", cutoff, journalEntryId, restores: parties.restores, createdBy: actor,
        counts: {
          clientsCreated: parties.created, clientsUpdated: parties.updated, sellers: plan.parsed.sellers.length,
          productsCreated: products.created, stockLines, invoices: invoices.length,
          unmatchedInvoices: plan.unmatched.length, creditNotesExcluded: plan.parsed.creditNotes.count,
        },
        totals: { receivables, creditNotesExcluded: plan.parsed.creditNotes.total, unmatched: preview.totals.unmatched },
        warnings: [...preview.notices, ...plan.warnings],
      }],
      { session },
    );
    return doc.toObject();
  });

  const after = await aging({ cutoff: cutoffText });
  const trial = await trialBalance({ period: cutoffText.slice(0, 7) });
  return {
    batch,
    verification: {
      imported: batch.totals.receivables,
      agingBefore,
      agingAfter: after.totals.total,
      agingMatches: after.totals.total - agingBefore === batch.totals.receivables,
      agingCuadra: after.cuadra,
      trialBalanceCuadra: trial.cuadra,
    },
  };
}
