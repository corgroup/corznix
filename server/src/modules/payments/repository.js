import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

export class PaymentRepository {
  async extendReservationForPayment(checkoutId,ttlSeconds){
    const result=await query(`UPDATE checkout_sessions cs JOIN inventory_reservations ir ON ir.id=cs.inventory_reservation_id
      SET ir.expires_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),cs.reservation_expires_at=DATE_ADD(NOW(3),INTERVAL ? SECOND),cs.expires_at=DATE_ADD(NOW(3),INTERVAL ? SECOND)
      WHERE cs.id=? AND cs.status='READY_FOR_PAYMENT' AND ir.status='RESERVED' AND ir.expires_at>NOW(3)`,[ttlSeconds,ttlSeconds,ttlSeconds,checkoutId]);
    return result.affectedRows>0;
  }
  async enabledProviders(){return query('SELECT * FROM payment_providers WHERE enabled=1 ORDER BY priority,provider_code');}
  async obligations(checkoutId){return query('SELECT * FROM payment_obligations WHERE checkout_id=? ORDER BY obligation_type',[checkoutId]);}
  async upsertObligation({checkoutId,type,amountMinor,currency,mode,status}){
    const id=randomUUID(); await query(`INSERT INTO payment_obligations (id,checkout_id,obligation_type,amount_minor,currency,status,source_payment_mode) VALUES (?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE amount_minor=IF(status='PAID',amount_minor,VALUES(amount_minor)),currency=VALUES(currency),status=IF(status='PAID',status,VALUES(status)),source_payment_mode=VALUES(source_payment_mode)`,[id,checkoutId,type,amountMinor,currency,status,mode]);
    return (await query('SELECT * FROM payment_obligations WHERE checkout_id=? AND obligation_type=?',[checkoutId,type]))[0];
  }
  async reusableAttempt(obligationId){return (await query("SELECT * FROM payment_attempts WHERE obligation_id=? AND status IN ('CREATED','PENDING','AUTHORIZED','SUCCEEDED') ORDER BY created_at DESC LIMIT 1",[obligationId]))[0]||null;}
  async openAttemptForCheckout(checkoutId){return (await query("SELECT * FROM payment_attempts WHERE checkout_id=? AND status IN ('CREATED','PENDING','AUTHORIZED','SUCCEEDED') ORDER BY created_at DESC LIMIT 1",[checkoutId]))[0]||null;}
  async createAttempt({obligation,providerCode}){const id=randomUUID();const key=randomUUID();const merchant=`pay_${id.replaceAll('-','')}`;try{await query(`INSERT INTO payment_attempts (id,obligation_id,checkout_id,provider_code,merchant_reference,amount_minor,currency,status,idempotency_key) VALUES (?,?,?,?,?,?,?,'CREATED',?)`,[id,obligation.id,obligation.checkout_id,providerCode,merchant,obligation.amount_minor,obligation.currency,key]);return (await query('SELECT * FROM payment_attempts WHERE id=?',[id]))[0];}catch(error){if(error.code==='ER_DUP_ENTRY'){const existing=await this.reusableAttempt(obligation.id);if(existing)return existing;}throw error;}}
  async attachSession(id,result){await query(`UPDATE payment_attempts SET provider_payment_id=?,provider_session_reference=?,provider_raw_status=?,status=?,session_expires_at=? WHERE id=? AND status='CREATED'`,[result.providerPaymentId,result.providerSessionReference,result.rawStatus,result.status,result.expiresAt?new Date(result.expiresAt):null,id]);return this.findAttempt(id);}
  async findAttempt(id){return (await query('SELECT * FROM payment_attempts WHERE id=?',[id]))[0]||null;}
  async findAttemptByMerchant(reference){return (await query('SELECT * FROM payment_attempts WHERE merchant_reference=? LIMIT 1',[reference]))[0]||null;}
  async ownedAttempt(customerId,checkoutId){return (await query(`SELECT pa.* FROM payment_attempts pa JOIN checkout_sessions cs ON cs.id=pa.checkout_id WHERE pa.checkout_id=? AND cs.customer_id=? ORDER BY pa.created_at DESC LIMIT 1`,[checkoutId,customerId]))[0]||null;}
  async ownedAttemptById(customerId,attemptId){return (await query(`SELECT pa.* FROM payment_attempts pa JOIN checkout_sessions cs ON cs.id=pa.checkout_id WHERE pa.id=? AND cs.customer_id=? LIMIT 1`,[attemptId,customerId]))[0]||null;}
  // `paymentGroup`/`paymentMethod` are only ever written when the provider
  // actually reported them — COALESCE keeps whatever a previous reconcile or
  // webhook already learned rather than blanking it on a later status-only
  // update.
  async transition(attempt,status,rawStatus,{failureCode=null,failureMessage=null,paymentGroup=null,paymentMethod=null}={}){if(attempt.status==='SUCCEEDED'&&status!=='SUCCEEDED')return attempt;await query(`UPDATE payment_attempts SET status=?,provider_raw_status=?,failure_code=?,failure_message_safe=?,payment_group=COALESCE(?,payment_group),payment_method=COALESCE(?,payment_method) WHERE id=? AND status<>'SUCCEEDED'`,[status,rawStatus,failureCode,failureMessage,paymentGroup,paymentMethod,attempt.id]);if(status==='SUCCEEDED')await query("UPDATE payment_obligations SET status='PAID' WHERE id=?",[attempt.obligation_id]);else if(status==='FAILED')await query("UPDATE payment_obligations SET status='FAILED' WHERE id=? AND status<>'PAID'",[attempt.obligation_id]);return this.findAttempt(attempt.id);}
  async recordEvent({providerCode,eventId,attemptId,eventType,payloadHash,verified}){const id=randomUUID();try{await query(`INSERT INTO payment_provider_events (id,provider_code,provider_event_id,payment_attempt_id,event_type,signature_verified,payload_sha256) VALUES (?,?,?,?,?,?,?)`,[id,providerCode,eventId,attemptId,eventType,verified,payloadHash]);return{id,duplicate:false};}catch(error){if(error.code==='ER_DUP_ENTRY')return{duplicate:true};throw error;}}
  async finishEvent(id,status){await query('UPDATE payment_provider_events SET processing_status=?,processed_at=NOW(3) WHERE id=?',[status,id]);}
}
export const paymentRepository=new PaymentRepository();
