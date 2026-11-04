import { Request, Response, NextFunction } from "express";
import { actorOf } from "../utils/actor";
import * as xmlService from "../services/purchaseXml.service";
import * as invoiceService from "../services/purchaseInvoice.service";
import * as creditNoteService from "../services/supplierCreditNote.service";
import * as payablesService from "../services/payables.service";
import * as paymentsService from "../services/supplierPayments.service";
import * as payableReports from "../services/payableReports.service";
import * as purchaseReports from "../services/purchaseReports.service";

const wrap =
  (fn: (req: Request) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await fn(req));
    } catch (error) {
      next(error);
    }
  };

const q = (req: Request) => req.query as Record<string, unknown>;
const id = (req: Request) => String(req.params.id);
/** El XML llega como texto plano (text/xml) o como { xml } en JSON. */
const xmlOf = (req: Request) => (typeof req.body === "string" ? req.body : req.body?.xml);

export const importXml = wrap((req) =>
  xmlService.importXml(xmlOf(req), { createSupplier: req.query.createSupplier === "true" || req.body?.createSupplier === true }),
);
export const importBatch = wrap((req) => xmlService.importBatch(req.body?.xmls));

export const listInvoices = wrap((req) => invoiceService.listInvoices(q(req)));
export const getInvoice = wrap((req) => invoiceService.getInvoice(id(req)));
export const createInvoice = wrap((req) => invoiceService.createInvoice(req.body, actorOf(req)), 201);
export const voidInvoice = wrap((req) => invoiceService.voidInvoice(id(req), req.body, actorOf(req)));
export const resendWithholding = wrap((req) => invoiceService.resendWithholding(id(req)));

export const listCreditNotes = wrap((req) => creditNoteService.listCreditNotes(q(req)));
export const createCreditNote = wrap((req) => creditNoteService.createCreditNote(req.body, actorOf(req)), 201);

export const listApprovals = wrap((req) => payablesService.listApprovals(q(req)));
export const approve = wrap((req) => payablesService.approve(req.body, actorOf(req)), 201);
export const cancelApproval = wrap((req) => payablesService.cancelApproval(id(req)));

export const listTransactions = wrap((req) => paymentsService.listTransactions(q(req)));
export const executePayment = wrap((req) => paymentsService.executePayment(req.body, actorOf(req)), 201);
export const createAdvance = wrap((req) => paymentsService.createAdvance(req.body, actorOf(req)), 201);
export const crossAdvance = wrap((req) => paymentsService.crossAdvance(id(req), req.body, actorOf(req)), 201);
export const refundAdvance = wrap((req) => paymentsService.refundAdvance(id(req), req.body, actorOf(req)), 201);
export const voidTransaction = wrap((req) => paymentsService.voidTransaction(id(req), req.body, actorOf(req)));

export const supplierBalances = wrap((req) => payableReports.supplierBalances(q(req)));
export const supplierStatement = wrap((req) => payableReports.supplierStatement(id(req), q(req)));
export const openAdvances = wrap((req) => payableReports.openAdvances(q(req)));
export const purchasesBySupplier = wrap((req) => purchaseReports.purchasesBySupplier(q(req)));
export const purchasesByAccount = wrap((req) => purchaseReports.purchasesByAccount(q(req)));
export const purchasesByTaxSupport = wrap((req) => purchaseReports.purchasesByTaxSupport(q(req)));
export const withholdingsReport = wrap((req) => purchaseReports.withholdingsReport(q(req)));
