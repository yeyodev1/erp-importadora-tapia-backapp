import { Request, Response, NextFunction } from "express";
import * as ats from "../services/ats.service";
import { atsXml } from "../services/atsXml.service";
import * as reconciliation from "../services/taxReconciliation.service";
import * as purchaseReports from "../services/purchaseReports.service";
import * as collections from "../services/collectionsReport.service";
import { todayStr } from "../services/ledgerReports.service";

const wrap =
  (fn: (req: Request) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await fn(req));
    } catch (error) {
      next(error);
    }
  };

const q = (req: Request) => req.query as Record<string, unknown>;
const period = (req: Request) => String(req.query.period ?? todayStr().slice(0, 7));

export const atsSummary = wrap((req) => ats.buildAts(period(req)));
export const monthlyReconciliation = wrap((req) => reconciliation.monthlyReconciliation(period(req)));

export async function atsFile(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await ats.buildAts(period(req));
    const [year, month] = data.period.split("-");
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ATS_${month}_${year}.xml"`);
    res.send(atsXml(data));
  } catch (error) {
    next(error);
  }
}

// Alias: los reportes ya viven en Compras y Cartera; aquí solo se exponen para el menú de Impuestos.
export const purchasesByTaxSupport = wrap((req) => purchaseReports.purchasesByTaxSupport(q(req)));
export const purchaseWithholdings = wrap((req) => purchaseReports.withholdingsReport(q(req)));
export const salesWithholdings = wrap((req) => collections.withholdingsReport(q(req)));
