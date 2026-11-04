import { Model } from "mongoose";
import { CustomError } from "../errors/customError.error";
import { SalesInvoice, ISalesInvoice } from "../models/salesInvoice.model";
import { SalesCreditNote } from "../models/salesCreditNote.model";
import { SalesDebitNote } from "../models/salesDebitNote.model";
import { renderRide, type SriStatus } from "./sri";
import type { RideFormat } from "./sri/ride";
import { creditNotePayload, debitNotePayload, invoicePayload } from "./salesSri.service";
import { oid } from "./salesCommon.service";

/**
 * RIDE en HTML de un documento de venta ya grabado: A4 (la factura grande) o
 * ticket de 80 mm (la pequeña que firma el cliente). Lleva el XML para que el
 * encabezado del emisor salga de lo que se firmó.
 */
type Kind = "invoice" | "creditNote" | "debitNote";

const MODELS: Record<Kind, Model<any>> = { invoice: SalesInvoice, creditNote: SalesCreditNote, debitNote: SalesDebitNote };

export async function ride(kind: Kind, id: string, format: unknown): Promise<string> {
  const fmt: RideFormat = format === "ticket" ? "ticket" : "a4";
  const doc = await MODELS[kind].findById(oid(id, "documento")).lean<any>();
  if (!doc) throw new CustomError("Documento no encontrado", 404);
  let payload;
  if (kind === "invoice") payload = invoicePayload(doc);
  else {
    const inv = await SalesInvoice.findById(doc.invoiceId).lean<ISalesInvoice>();
    if (!inv) throw new CustomError("Factura del documento no encontrada", 404);
    payload = kind === "creditNote" ? creditNotePayload(doc, inv) : debitNotePayload(doc, inv);
  }
  const status = (doc.sriStatus || "error") as SriStatus;
  return renderRide(payload, {
    accessKey: doc.accessKey ?? "", status, authorizationNumber: doc.authorizationNumber ?? "",
    authorizationDate: doc.authorizationDate ?? null, messages: doc.sriMessages ?? [], xml: doc.xml ?? "",
  }, fmt);
}
