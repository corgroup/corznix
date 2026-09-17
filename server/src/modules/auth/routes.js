import express, { Router } from 'express';
import * as authController from './controller.js';
import { authenticate, authenticateOptional } from '../../middleware/authenticate.js';
import { otpRequestLimiter, otpVerifyLimiter, authLimiter } from '../../middleware/authRateLimit.js';

// Real auth module (Wave 5 — see docs/MIGRATION.md). Replaces the
// `createStubRouter('auth')` placeholder.
const router = Router();

router.get('/session', authenticateOptional, authController.getSession);
router.post('/otp/request', otpRequestLimiter, authController.requestOtp);
router.post('/otp/verify', otpVerifyLimiter, authController.verifyOtp);
router.post('/google', authLimiter, authController.loginWithGoogle);
// Issued to the storefront just before it shows the Google button.
router.post('/google/nonce', authLimiter, authController.googleNonce);
// Google posts the credential here as a form from their own origin (the
// redirect UX). express.json() will not touch a form body, so this route
// brings its own parser; nothing else on the API accepts urlencoded input.
router.post('/google/callback', authLimiter, express.urlencoded({ extended: false, limit: '16kb' }), authController.googleRedirectCallback);
router.post('/refresh', authLimiter, authController.refresh);
router.post('/identity-link/confirm', authenticate, authController.confirmIdentityLink);
router.post('/profile/complete', authenticate, authController.completeProfile);
router.post('/logout', authenticate, authController.logout);

export default router;
