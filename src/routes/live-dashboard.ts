import { Router, Request, Response } from "express";
import path from "path";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "../../public/dashboard.html"));
});

export default router;
