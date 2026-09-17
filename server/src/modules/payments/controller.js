import { paymentService } from './service.js';
const send=(res,data,status=200)=>res.status(status).json({data});
export async function createSession(req,res,next){try{send(res,await paymentService.createSession(req.customer.id,req.params.id),201);}catch(error){next(error);}}
export async function status(req,res,next){try{send(res,await paymentService.status(req.customer.id,req.params.id));}catch(error){next(error);}}
export async function reconcile(req,res,next){try{send(res,await paymentService.status(req.customer.id,req.params.id,{reconcile:true}));}catch(error){next(error);}}
export async function cashfreeWebhook(req,res,next){try{send(res,await paymentService.webhook('CASHFREE',{headers:req.headers,rawBody:req.rawBody}));}catch(error){next(error);}}
export async function razorpayWebhook(req,res,next){try{send(res,await paymentService.webhook('RAZORPAY',{headers:req.headers,rawBody:req.rawBody}));}catch(error){next(error);}}
export async function paymentReturnStatus(req,res,next){try{send(res,await paymentService.returnStatus(req.customer.id,req.params.attemptId));}catch(error){next(error);}}
