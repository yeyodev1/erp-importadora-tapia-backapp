import { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../types/AuthRequest";
import { actorOf } from "../utils/actor";
import * as journalService from "../services/journal.service";
import * as ledgerReports from "../services/ledgerReports.service";
import * as financialStatements from "../services/financialStatements.service";
import * as yearCloseService from "../services/yearClose.service";
import * as chartImportService from "../services/chartImport.service";

const wrap =
  (fn: (req: AuthRequest) => Promise<unknown>, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json(await fn(req as AuthRequest));
    } catch (error) {
      next(error);
    }
  };

const query = (req: Request) => req.query as Record<string, unknown>;

export const searchEntries = wrap((req) => journalService.search(query(req)));
export const getEntry = wrap((req) => journalService.getEntry(String(req.params.id)));
export const createEntry = wrap((req) => journalService.createManual(req.body, actorOf(req)), 201);
export const voidEntry = wrap((req) => journalService.voidManual(String(req.params.id), req.body, actorOf(req)));

export const journalBook = wrap((req) => ledgerReports.journalBook(query(req)));
export const ledger = wrap((req) => ledgerReports.ledger(query(req)));
export const trialBalance = wrap((req) => ledgerReports.trialBalance(query(req)));
export const comparative = wrap((req) => ledgerReports.comparative(query(req)));
export const incomeStatement = wrap((req) => financialStatements.incomeStatement(query(req)));
export const balanceSheet = wrap((req) => financialStatements.balanceSheet(query(req)));

export const listCloses = wrap(() => yearCloseService.listCloses());
export const closeYear = wrap((req) => yearCloseService.closeYear(req.body, actorOf(req)), 201);
export const reopenYear = wrap((req) => yearCloseService.reopenYear(req.params.year, req.body, actorOf(req)));

export const importChart = wrap((req) => chartImportService.importChart(req.body));
