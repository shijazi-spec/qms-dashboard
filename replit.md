# QMS - Quality Management System

## Overview
A Node.js web application serving REST API endpoints and HTML dashboards for Quality Management. Built with Express on port 5000, designed for Autoscale deployment.

## Architecture
- **Frontend**: React + Vite with Tailwind CSS and shadcn/ui components
- **Backend**: Express REST API
- **Database**: PostgreSQL with Drizzle ORM
- **Routing**: wouter for client-side, Express for API

## Project Structure
- `client/src/pages/` - Dashboard, Documents, Audits, Non-Conformances, CAPAs pages
- `client/src/components/` - Sidebar navigation, theme toggle, shadcn/ui components
- `server/` - Express server, API routes, database storage layer, seed data
- `shared/schema.ts` - Drizzle schemas for documents, audits, non_conformances, capas

## API Endpoints
- `GET/POST /api/documents` - Document control
- `GET/POST /api/audits` - Audit management
- `GET/POST /api/non-conformances` - NC tracking
- `GET/POST /api/capas` - CAPA management

## Running
- `npm run dev` starts Express + Vite dev server on port 5000
- `npm run db:push` pushes schema to PostgreSQL

## Recent Changes
- Initial QMS scaffold with all CRUD endpoints and dashboard views
