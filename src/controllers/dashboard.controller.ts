import { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../types/AuthRequest";
import * as dashboardService from "../services/dashboard.service";

export async function getDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const user = (req as AuthRequest).user!;
    res.json(await dashboardService.getDashboard({ role: user.role, name: user.name }, req.query as Record<string, unknown>));
  } catch (error) {
    next(error);
  }
}
