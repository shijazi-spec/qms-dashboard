import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import {
  insertDocumentSchema,
  insertAuditSchema,
  insertNonConformanceSchema,
  insertCapaSchema,
} from "@shared/schema";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Documents
  app.get("/api/documents", async (_req, res) => {
    const docs = await storage.getDocuments();
    res.json(docs);
  });

  app.get("/api/documents/:id", async (req, res) => {
    const doc = await storage.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ message: "Document not found" });
    res.json(doc);
  });

  app.post("/api/documents", async (req, res) => {
    const parsed = insertDocumentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const doc = await storage.createDocument(parsed.data);
    res.status(201).json(doc);
  });

  // Audits
  app.get("/api/audits", async (_req, res) => {
    const list = await storage.getAudits();
    res.json(list);
  });

  app.get("/api/audits/:id", async (req, res) => {
    const audit = await storage.getAudit(req.params.id);
    if (!audit) return res.status(404).json({ message: "Audit not found" });
    res.json(audit);
  });

  app.post("/api/audits", async (req, res) => {
    const body = {
      ...req.body,
      scheduledDate: req.body.scheduledDate ? new Date(req.body.scheduledDate) : undefined,
      completedDate: req.body.completedDate ? new Date(req.body.completedDate) : undefined,
    };
    const parsed = insertAuditSchema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const audit = await storage.createAudit(parsed.data);
    res.status(201).json(audit);
  });

  // Non-Conformances
  app.get("/api/non-conformances", async (_req, res) => {
    const list = await storage.getNonConformances();
    res.json(list);
  });

  app.get("/api/non-conformances/:id", async (req, res) => {
    const nc = await storage.getNonConformance(req.params.id);
    if (!nc) return res.status(404).json({ message: "Non-conformance not found" });
    res.json(nc);
  });

  app.post("/api/non-conformances", async (req, res) => {
    const body = {
      ...req.body,
      dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined,
    };
    const parsed = insertNonConformanceSchema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const nc = await storage.createNonConformance(parsed.data);
    res.status(201).json(nc);
  });

  // CAPAs
  app.get("/api/capas", async (_req, res) => {
    const list = await storage.getCapas();
    res.json(list);
  });

  app.get("/api/capas/:id", async (req, res) => {
    const capa = await storage.getCapa(req.params.id);
    if (!capa) return res.status(404).json({ message: "CAPA not found" });
    res.json(capa);
  });

  app.post("/api/capas", async (req, res) => {
    const body = {
      ...req.body,
      dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined,
    };
    const parsed = insertCapaSchema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const capa = await storage.createCapa(parsed.data);
    res.status(201).json(capa);
  });

  return httpServer;
}
