import { createHash } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { documentRepository } from './repository.js';
import { documentService } from './service.js';
import { documentStorage } from './storage.js';

const LABEL_TYPES = new Set(['PDF4X6', 'ZPL']);

// Queues print jobs against warehouse-scoped print stations. There is no real
// printer — a job is marked PRINTED synchronously (a warehouse-local print
// bridge would do this over a callback later).
//
// Phase 6 security pass (DESIGN.md §5.3) — every station/printer lookup now
// filters by actor.brandId at the SQL level first (documentRepository's
// station()/printer() methods), so a cross-brand id 404s outright; the
// warehouse-assignment scope check on top uses warehouseScopeForStaff's now
// brand-bounded warehouseIds unconditionally (see requireWarehouseAccess.js
// for why `scope.all` alone used to be an unsafe shortcut here).
export class PrintService {
  constructor({ repository = documentRepository, documents = documentService } = {}) {
    this.repository = repository;
    this.documents = documents;
  }

  async #assertStation(actor, stationOrWarehouseId) {
    const scope = await warehouseScopeForStaff(actor, actor?.brandId);
    if (!scope.warehouseIds.includes(stationOrWarehouseId)) {
      throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to this warehouse.', 403);
    }
  }

  async listStations(actor) {
    const scope = await warehouseScopeForStaff(actor, actor?.brandId);
    const rows = await this.repository.stations(actor?.brandId);
    const visible = rows.filter((s) => scope.warehouseIds.includes(s.warehouse_id));
    return Promise.all(visible.map(async (s) => ({ ...s, printers: await this.repository.printers(s.id, actor?.brandId) })));
  }

  async createStation(actor, { warehouseId, name }) {
    await this.#assertStation(actor, warehouseId);
    return this.repository.createStation({ warehouseId, name });
  }

  async updateStation(actor, id, fields) {
    const station = await this.repository.station(id, actor?.brandId);
    if (!station) throw new AppError('PRINT_STATION_NOT_FOUND', 'Print station not found.', 404);
    await this.#assertStation(actor, station.warehouse_id);
    return this.repository.updateStation(id, actor?.brandId, fields);
  }

  async listPrinters(actor, stationId) {
    const station = await this.repository.station(stationId, actor?.brandId);
    if (!station) throw new AppError('PRINT_STATION_NOT_FOUND', 'Print station not found.', 404);
    await this.#assertStation(actor, station.warehouse_id);
    return this.repository.printers(stationId, actor?.brandId);
  }

  async createPrinter(actor, body) {
    const station = await this.repository.station(body.printStationId, actor?.brandId);
    if (!station) throw new AppError('PRINT_STATION_NOT_FOUND', 'Print station not found.', 404);
    await this.#assertStation(actor, station.warehouse_id);
    return this.repository.createPrinter(body);
  }

  async updatePrinter(actor, id, fields) {
    const printer = await this.repository.printer(id, actor?.brandId);
    if (!printer) throw new AppError('PRINTER_NOT_FOUND', 'Printer not found.', 404);
    await this.#assertStation(actor, printer.warehouse_id);
    return this.repository.updatePrinter(id, actor?.brandId, fields);
  }

  async listJobs(actor, filters) {
    const scope = await warehouseScopeForStaff(actor, actor?.brandId);
    const jobs = await this.repository.jobs(filters);
    const stations = new Map((await this.repository.stations(actor?.brandId)).map((s) => [s.id, s.warehouse_id]));
    // A job whose station isn't in this brand's station map at all (foreign
    // print_station_id) is filtered out the same way as one outside scope.
    return jobs.filter((j) => scope.warehouseIds.includes(stations.get(j.print_station_id)));
  }

  /** Queue a print job for a document on a printer at the same warehouse, then run it. */
  async queueJob(actor, { documentId, printerId, copies = 1 }) {
    const doc = await this.repository.documentById(documentId);
    if (!doc) throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found.', 404);
    if (doc.status !== 'READY' || !doc.storage_key) throw new AppError('DOCUMENT_NOT_READY', 'This document has no rendered artefact to print.', 409);
    const printer = await this.repository.printer(printerId, actor?.brandId);
    if (!printer) throw new AppError('PRINTER_NOT_FOUND', 'Printer not found.', 404);
    if (printer.status !== 'ACTIVE' || printer.station_status !== 'ACTIVE') {
      throw new AppError('PRINTER_UNAVAILABLE', 'The printer or its station is disabled.', 409);
    }
    await this.documents.assertStaffAccess(actor, doc);
    if (doc.warehouse_id && printer.warehouse_id !== doc.warehouse_id) {
      throw new AppError('PRINT_WAREHOUSE_MISMATCH', 'A document can only be printed at its own warehouse.', 409);
    }
    if (LABEL_TYPES.has(doc.format) && printer.printer_type === 'A4_PDF') {
      throw new AppError('PRINTER_FORMAT_MISMATCH', 'This printer cannot print a 4x6 label.', 409);
    }

    // Load the actual artefact and verify integrity BEFORE the job is marked
    // printed — a mock transport, but a real one over real bytes.
    const bytes = await documentStorage.get(doc.storage_key);
    if (!bytes?.length || createHash('sha256').update(bytes).digest('hex') !== doc.sha256) {
      throw new AppError('DOCUMENT_INTEGRITY_FAILED', 'The document artefact failed its integrity check.', 502);
    }

    const job = await this.repository.createJob({
      documentId, printerId, printStationId: printer.print_station_id, staffId: actor?.id, copies,
    });
    await this.repository.setJobStatus(job.id, 'PRINTED', { attempts: 1, started_at: new Date(), completed_at: new Date() });
    return { ...await this.repository.job(job.id), artefactBytes: bytes.length };
  }

  async retryJob(actor, jobId) {
    const job = await this.repository.job(jobId);
    if (!job) throw new AppError('PRINT_JOB_NOT_FOUND', 'Print job not found.', 404);
    if (job.status !== 'FAILED') throw new AppError('PRINT_JOB_NOT_RETRYABLE', 'Only a failed job can be retried.', 409);
    const printer = await this.repository.printer(job.printer_id, actor?.brandId);
    if (!printer) throw new AppError('PRINT_JOB_NOT_FOUND', 'Print job not found.', 404);
    await this.#assertStation(actor, printer.warehouse_id);
    await this.repository.setJobStatus(jobId, 'PRINTED', { attempts: Number(job.attempts) + 1, completed_at: new Date() });
    return this.repository.job(jobId);
  }
}

export const printService = new PrintService();
