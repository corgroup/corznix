import { env } from '../../config/index.js';
import { orderRepository } from './repository.js';
import { orderFinalizationService } from './service.js';

export async function finalizeOrderBatch({repository=orderRepository,service=orderFinalizationService,batchSize=env.ORDER_FINALIZATION_BATCH_SIZE}={}){
  const checkoutIds=await repository.claim(batchSize);
  for(const checkoutId of checkoutIds){
    try{await service.finalize(checkoutId,{source:'RECOVERY_WORKER'});}
    catch(error){if(error.code!=='FULL_COD_PLACE_ORDER_REQUIRED')console.error('[order-finalization]',{category:error.code||'FAILED'});}
  }
  return checkoutIds.length;
}
export function startOrderFinalizationWorker(){
  if(!env.ORDER_FINALIZATION_WORKER_ENABLED)return()=>{};
  const timer=setInterval(()=>finalizeOrderBatch().catch(error=>console.error('[order-finalization-worker]',{category:error.code||'FAILED'})),env.ORDER_FINALIZATION_INTERVAL_MS);
  timer.unref();
  return()=>clearInterval(timer);
}
