import { Request, Response, NextFunction } from "express";
import type { AuthRequest } from "../types/AuthRequest";
import * as notificationsService from "../services/notifications.service";

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    res.json(await notificationsService.listNotifications((req as AuthRequest).user!.role));
  } catch (error) {
    next(error);
  }
}
