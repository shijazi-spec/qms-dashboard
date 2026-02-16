import { db } from "./db";
import { eq } from "drizzle-orm";
import {
  documents,
  audits,
  nonConformances,
  capas,
  type Document,
  type InsertDocument,
  type Audit,
  type InsertAudit,
  type NonConformance,
  type InsertNonConformance,
  type Capa,
  type InsertCapa,
} from "@shared/schema";

export interface IStorage {
  getDocuments(): Promise<Document[]>;
  getDocument(id: string): Promise<Document | undefined>;
  createDocument(doc: InsertDocument): Promise<Document>;

  getAudits(): Promise<Audit[]>;
  getAudit(id: string): Promise<Audit | undefined>;
  createAudit(audit: InsertAudit): Promise<Audit>;

  getNonConformances(): Promise<NonConformance[]>;
  getNonConformance(id: string): Promise<NonConformance | undefined>;
  createNonConformance(nc: InsertNonConformance): Promise<NonConformance>;

  getCapas(): Promise<Capa[]>;
  getCapa(id: string): Promise<Capa | undefined>;
  createCapa(capa: InsertCapa): Promise<Capa>;
}

export class DatabaseStorage implements IStorage {
  async getDocuments(): Promise<Document[]> {
    return db.select().from(documents);
  }

  async getDocument(id: string): Promise<Document | undefined> {
    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    return doc;
  }

  async createDocument(doc: InsertDocument): Promise<Document> {
    const [created] = await db.insert(documents).values(doc).returning();
    return created;
  }

  async getAudits(): Promise<Audit[]> {
    return db.select().from(audits);
  }

  async getAudit(id: string): Promise<Audit | undefined> {
    const [audit] = await db.select().from(audits).where(eq(audits.id, id));
    return audit;
  }

  async createAudit(audit: InsertAudit): Promise<Audit> {
    const [created] = await db.insert(audits).values(audit).returning();
    return created;
  }

  async getNonConformances(): Promise<NonConformance[]> {
    return db.select().from(nonConformances);
  }

  async getNonConformance(id: string): Promise<NonConformance | undefined> {
    const [nc] = await db.select().from(nonConformances).where(eq(nonConformances.id, id));
    return nc;
  }

  async createNonConformance(nc: InsertNonConformance): Promise<NonConformance> {
    const [created] = await db.insert(nonConformances).values(nc).returning();
    return created;
  }

  async getCapas(): Promise<Capa[]> {
    return db.select().from(capas);
  }

  async getCapa(id: string): Promise<Capa | undefined> {
    const [capa] = await db.select().from(capas).where(eq(capas.id, id));
    return capa;
  }

  async createCapa(capa: InsertCapa): Promise<Capa> {
    const [created] = await db.insert(capas).values(capa).returning();
    return created;
  }
}

export const storage = new DatabaseStorage();
