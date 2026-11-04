import { Request, Response, NextFunction } from "express";
import * as cloudinaryService from "../services/cloudinary.service";

/** GET /api/uploads/signature?folder=productos */
export async function signature(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(200).json(cloudinaryService.uploadSignature(String(req.query.folder ?? "productos")));
  } catch (error) {
    next(error);
  }
}
