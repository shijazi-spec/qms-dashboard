import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const documents = pgTable("documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  documentNumber: text("document_number").notNull().unique(),
  revision: text("revision").notNull().default("1.0"),
  status: text("status").notNull().default("draft"),
  category: text("category").notNull(),
  owner: text("owner").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const audits = pgTable("audits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  auditNumber: text("audit_number").notNull().unique(),
  type: text("type").notNull(),
  status: text("status").notNull().default("planned"),
  auditor: text("auditor").notNull(),
  department: text("department").notNull(),
  scheduledDate: timestamp("scheduled_date").notNull(),
  completedDate: timestamp("completed_date"),
  findings: integer("findings").default(0),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const nonConformances = pgTable("non_conformances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  ncNumber: text("nc_number").notNull().unique(),
  severity: text("severity").notNull(),
  status: text("status").notNull().default("open"),
  source: text("source").notNull(),
  department: text("department").notNull(),
  assignedTo: text("assigned_to").notNull(),
  description: text("description"),
  rootCause: text("root_cause"),
  dueDate: timestamp("due_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const capas = pgTable("capas", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  capaNumber: text("capa_number").notNull().unique(),
  type: text("type").notNull(),
  status: text("status").notNull().default("open"),
  priority: text("priority").notNull(),
  assignedTo: text("assigned_to").notNull(),
  department: text("department").notNull(),
  description: text("description"),
  ncReference: text("nc_reference"),
  dueDate: timestamp("due_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertAuditSchema = createInsertSchema(audits).omit({
  id: true,
  createdAt: true,
});
export const insertNonConformanceSchema = createInsertSchema(nonConformances).omit({
  id: true,
  createdAt: true,
});
export const insertCapaSchema = createInsertSchema(capas).omit({
  id: true,
  createdAt: true,
});

export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documents.$inferSelect;
export type InsertAudit = z.infer<typeof insertAuditSchema>;
export type Audit = typeof audits.$inferSelect;
export type InsertNonConformance = z.infer<typeof insertNonConformanceSchema>;
export type NonConformance = typeof nonConformances.$inferSelect;
export type InsertCapa = z.infer<typeof insertCapaSchema>;
export type Capa = typeof capas.$inferSelect;
