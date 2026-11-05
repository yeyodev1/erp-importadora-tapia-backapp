import { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../types/AuthRequest";
import { actorOf } from "../utils/actor";
import * as invoiceService from "../services/invoice.service";
import * as receiptService from "../services/receipt.service";
import * as checkService from "../services/postdatedCheck.service";
import * as withholdingService from "../services/withholding.service";
import * as reportService from "../services/receivablesReport.service";
import * as collectionsService from "../services/collectionsReport.service";

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

export const openInvoices = wrap((req) => invoiceService.listInvoices({ ...q(req), status: "vigente", pending: "true", includeOpening: "true" }));

export const createReceipt = wrap((req) => receiptService.createReceipt(req.body, actorOf(req)), 201);
export const listReceipts = wrap((req) => receiptService.listReceipts(q(req)));
export const getReceipt = wrap((req) => receiptService.getReceipt(id(req)));
export const voidReceipt = wrap((req) => receiptService.voidReceipt(id(req), req.body ?? {}, actorOf(req)));

export const listChecks = wrap(async (req) => checkService.listChecks(q(req)));
export const depositCheck = wrap((req) => checkService.depositCheck(id(req), req.body ?? {}, actorOf(req)));
export const confirmCheck = wrap((req) => checkService.confirmCheck(id(req), req.body ?? {}, actorOf(req)));
export const returnCheck = wrap((req) => checkService.returnCheck(id(req), req.body ?? {}, actorOf(req)));

export const createWithholding = wrap((req) => withholdingService.createWithholding(req.body, actorOf(req)), 201);
export const listWithholdings = wrap((req) => withholdingService.listWithholdings(q(req)));

export const report = wrap((req) => reportService.receivablesReport(q(req)));
export const withholdingsReport = wrap((req) => collectionsService.withholdingsReport(q(req)));
export const commissions = wrap((req) => collectionsService.commissions(q(req)));
