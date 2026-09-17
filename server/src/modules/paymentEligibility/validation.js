import { AppError } from '../../utils/errors.js';

export function validateValueRule(candidate, activeRules=[]) {
  const min=Number(candidate.minAmountMinor); const max=candidate.maxAmountMinor==null?null:Number(candidate.maxAmountMinor);
  const advance=Number(candidate.advanceValue||0);
  if (!Number.isInteger(min)||min<0||max!=null&&(!Number.isInteger(max)||max<min)) throw new AppError('COD_VALUE_RULE_INVALID','COD range is invalid.',400);
  if (candidate.advanceType==='PERCENTAGE'&&(!Number.isInteger(advance)||advance<1||advance>10000)) throw new AppError('COD_VALUE_RULE_INVALID','Percentage advance must be 1–10000 basis points.',400);
  if (candidate.advanceType==='FIXED'&&(!Number.isInteger(advance)||advance<=0)) throw new AppError('COD_VALUE_RULE_INVALID','Fixed advance must be a positive minor-unit amount.',400);
  const overlaps=activeRules.some((row)=>min<=Number(row.max_amount_minor??Number.MAX_SAFE_INTEGER)&&Number(row.min_amount_minor)<=Number(max??Number.MAX_SAFE_INTEGER));
  if (overlaps) throw new AppError('COD_VALUE_RULE_OVERLAP','Active COD value ranges cannot overlap.',409);
  return true;
}
