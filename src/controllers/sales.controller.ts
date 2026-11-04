import { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../types/AuthRequest";
import { actorOf } from "../utils/actor";
import * as invoiceService from "../services/invoice.service";
import * as creditNoteService from "../services/creditNote.service";
import * as debitNoteService from "../services/debitNote.service";
import * as proformaService from "../services/proforma.service";
import * as salesReportService from "../services/salesReport.service";
import * as salesRideService from "../services/salesRide.service";

const wrap =
  (fn: (req: AuthRequest) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await fn(req as AuthRequest));
    } catch (error) {
      next(error);
    }
  };

const q = (req: Request) => req.query as Record<string, unknown>;
const id = (req: Request) => String(req.params.id);

export const createInvoice = wrap((req) => invoiceService.createInvoice(req.body, actorOf(req)), 201);
export const listInvoices = wrap((req) => invoiceService.listInvoices(q(req)));
export const getInvoice = wrap((req) => invoiceService.getInvoice(id(req)));
export const voidInvoice = wrap((req) => invoiceService.voidInvoice(id(req), req.body ?? {}, actorOf(req)));
export const retryInvoiceSri = wrap((req) => invoiceService.retrySri(id(req)));

export const createCreditNote = wrap((req) => creditNoteService.createCreditNote(req.body, actorOf(req)), 201);
export const listCreditNotes = wrap((req) => creditNoteService.listCreditNotes(q(req)));
export const getCreditNote = wrap((req) => creditNoteService.getCreditNote(id(req)));
export const retryCreditNoteSri = wrap((req) => creditNoteService.retrySri(id(req)));

export const createDebitNote = wrap((req) => debitNoteService.createDebitNote(req.body, actorOf(req)), 201);
export const listDebitNotes = wrap((req) => debitNoteService.listDebitNotes(q(req)));
export const retryDebitNoteSri = wrap((req) => debitNoteService.retrySri(id(req)));

export const createProforma = wrap((req) => proformaService.createProforma(req.body, actorOf(req)), 201);
export const listProformas = wrap((req) => proformaService.listProformas(q(req)));
export const getProforma = wrap((req) => proformaService.getProforma(id(req)));
export const invoiceProforma = wrap((req) => proformaService.invoiceProforma(id(req), req.body ?? {}, actorOf(req)), 201);

export const salesReport = wrap((req) => salesReportService.salesReport(q(req)));
export const topProducts = wrap((req) => salesReportService.topProducts(q(req)));

/** RIDE en HTML (?format=a4|ticket): el front lo abre en un iframe imprimible. */
const rideOf =
  (kind: "invoice" | "creditNote" | "debitNote") => async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.type("html").send(await salesRideService.ride(kind, id(req), req.query.format));
    } catch (error) {
      next(error);
    }
  };
export const invoiceRide = rideOf("invoice");
export const creditNoteRide = rideOf("creditNote");
export const debitNoteRide = rideOf("debitNote");
