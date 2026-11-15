import type { NextApiRequest, NextApiResponse } from 'next';
import twilio from 'twilio';

// Validate required environment variables
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid || !authToken || !twilioPhoneNumber) {
  throw new Error(
    'Twilio SMS credentials not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in .env'
  );
}

const client = twilio(accountSid, authToken);

/**
 * Send SMS via Twilio API
 *
 * Expected request body:
 *   - to: string (E.164 format, e.g. +919876543210)
 *   - body: string (SMS message text)
 *
 * Response:
 *   - success: true/false
 *   - sid: Twilio message SID (if successful)
 *   - status: Twilio message status (if successful)
 *   - error: error message (if unsuccessful)
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Rate limiting would be applied at the middleware level;
  // per-API-key rate limiting (Phase 5.3) should key by engagement/firm ID

  const { to, body } = req.body as { to: string; body: string };

  if (!to || !body) {
    return res
      .status(400)
      .json({ success: false, error: 'Missing required fields: to, body' });
  }

  // Validate E.164 format (basic check: starts with + and has enough digits)
  const e164Pattern = /^\+[1-9]\d{1,14}$/;
  if (!e164Pattern.test(to)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid phone number format. Use E.164 format (e.g. +919876543210)',
    });
  }

  try {
    const message = await client.messages.create({
      body,
      from: twilioPhoneNumber,
      to,
    });

    return res.status(200).json({
      success: true,
      sid: message.sid,
      status: message.status,
      dateCreated: message.dateCreated,
    });
  } catch (error: any) {
    console.error('Twilio SMS error:', error);

    // Provide helpful error messages for common Twilio errors
    let userFriendlyError = 'Failed to send SMS';

    if (error.status === 400) {
      userFriendlyError = 'Bad request - check phone number format and message body';
    } else if (error.status === 401) {
      userFriendlyError = 'Authentication failed - check Twilio credentials';
    } else if (error.status === 403) {
      userFriendlyError = 'Forbidden - check Twilio phone number permissions';
    } else if (error.code === 'ACCOUNT_LIMIT') {
      userFriendlyError = 'Account limit reached - check Twilio plan';
    } else if (error.code === 'RATE_LIMIT') {
      userFriendlyError = 'Rate limit exceeded - please try again later';
    }

    return res.status(500).json({
      success: false,
      error: userFriendlyError,
    });
  }
}

// Export helper for use in other modules
export { client as twilioClient };