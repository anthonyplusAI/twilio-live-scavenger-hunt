import { createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import twilio from 'twilio';
import { Analytics } from '@segment/analytics-node';
import { ValidationError } from './config.mjs';

const safeMetricKeys = new Set([
  'heatId', 'heat', 'playerId', 'playerCount', 'queued', 'promptId', 'category',
  'channel', 'windowType', 'windowId', 'choice', 'source',
  'isOverride', 'timeToMatchMs', 'candidateCount', 'votes', 'promoted', 'sessionId',
]);
const text = value => String(value ?? '').trim();
const sameSender = (left, right, channel) => {
  const normalize = value => {
    const sender = text(value).toLowerCase();
    return channel === 'sms' ? sender.replace(/^\+/, '') : sender;
  };
  return normalize(left) === normalize(right);
};
const eventCode = event => text(event.vote?.eventCode || event.slug.replace(/-/g, '').slice(0, 20)).toUpperCase();
// A 5xx response may arrive after SendGrid accepted the message; only 429 is safe to retry.
const SENDGRID_RETRY_STATUSES = new Set([429]);
const SENDGRID_EVENT_STATUSES = {
  processed: 'processed', deferred: 'deferred', delivered: 'delivered',
  bounce: 'bounced', dropped: 'dropped',
};
const TERMINAL_DELIVERY_STATUSES = new Set(['delivered', 'bounced', 'dropped']);
const sendGridReady = env => Boolean(env.SENDGRID_API_KEY && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(env.SENDGRID_FROM_EMAIL)));

class SendGridResponseError extends Error {
  constructor(status) {
    super(`SendGrid returned ${status}.`);
    this.statusCode = status;
    this.retryable = SENDGRID_RETRY_STATUSES.has(status);
    this.uncertain = status >= 500 && !this.retryable;
  }
}

export class Integrations {
  constructor({ store, engine, media, publicBaseUrl = '', env = process.env,
    segmentClient = null, sendgridClient = null, fetchImpl = fetch } = {}) {
    this.store = store;
    this.engine = engine;
    this.media = media;
    this.publicBaseUrl = publicBaseUrl;
    this.env = env;
    this.fetch = fetchImpl;
    this.voteSecret = env.VOTE_HMAC_SECRET || store.getOrCreateSetting('vote_hmac_secret', () => randomBytes(32).toString('hex'));
    this.segment = segmentClient || (env.SEGMENT_WRITE_KEY ? new Analytics({ writeKey: env.SEGMENT_WRITE_KEY }) : null);
    this.segment?.on?.('error', error => console.error(`Segment delivery: ${error.message}`));
    this.sendgrid = sendgridClient || { send: message => this._sendGridRequest(message) };
  }

  async _sendGridRequest(message) {
    const baseUrl = this.env.SENDGRID_REGION === 'eu' ? 'https://api.eu.sendgrid.com' : 'https://api.sendgrid.com';
    const response = await this.fetch(`${baseUrl}/v3/mail/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }],
          ...(message.jobId ? { custom_args: { lsh_job_id: message.jobId } } : {}) }],
        from: { email: message.from }, subject: message.subject,
        content: [
          { type: 'text/plain', value: message.text },
          { type: 'text/html', value: message.html },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    // Mail Send only confirms acceptance. Delivery is confirmed by the signed Event Webhook.
    if (response.status !== 202) throw new SendGridResponseError(response.status);
    return { providerMessageId: response.headers?.get?.('x-message-id') || null };
  }

  hashVoter(channel, identity) {
    return createHmac('sha256', this.voteSecret).update(`${channel}:${String(identity)}`).digest('hex');
  }

  track(item) {
    if (!this.segment) return;
    const properties = { eventId: item.eventId };
    for (const [key, value] of Object.entries(item.properties || {})) {
      if (safeMetricKeys.has(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) properties[key] = value;
    }
    try {
      const playerSession = item.properties?.playerId
        ? this.store.getPlayer(item.properties.playerId)?.analyticsSessionId : null;
      this.segment.track({
        anonymousId: item.properties?.sessionId || playerSession || item.properties?.voterId ||
          (item.properties?.playerId ? `player:${item.properties.playerId}` : `event:${item.eventId}`),
        event: item.type, properties, timestamp: item.at,
      });
    } catch (error) { console.error(`Segment track: ${error.message}`); }
  }

  identifyOptedInLead(lead) {
    if (!this.segment || this.env.SEGMENT_IDENTIFY_LEADS !== '1' || !lead.marketingOptIn) return;
    const traits = { email: lead.email || undefined, name: lead.name || undefined,
      company: lead.company || undefined, eventId: lead.eventId };
    const anonymousId = lead.analyticsSessionId || (String(lead.participantId || '').startsWith('spectator:')
      ? String(lead.participantId).slice('spectator:'.length)
      : this.store.getPlayer(lead.participantId)?.analyticsSessionId);
    try { this.segment.identify({ userId: lead.id, ...(anonymousId ? { anonymousId } : {}), traits }); }
    catch (error) { console.error(`Segment identify: ${error.message}`); }
  }

  async sendGuide(lead, event, jobId = null) {
    if (lead.intent !== 'guide') return 'operator-follow-up';
    if (!lead.email) return 'pending-email';
    if (!sendGridReady(this.env)) return 'pending-configuration';
    const safeName = String(lead.name || 'there').replace(/[<>&"']/g, '').slice(0, 80);
    await this.sendgrid.send({
        to: lead.email, from: this.env.SENDGRID_FROM_EMAIL,
        jobId,
        subject: `Your ${event.name} build guide`,
        text: `Hi ${safeName},\n\nThanks for playing Live Scavenger Hunt. Explore how to build your own real-time experience with Twilio Video, Messaging, and Segment:\n\nVideo: https://www.twilio.com/docs/video\nMessaging: https://www.twilio.com/docs/messaging\nSegment: https://www.twilio.com/docs/segment\n\nIf you requested an expert, the booth team can follow up separately.\n`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#172042"><div style="font-weight:800;letter-spacing:.15em;color:#e2231a">TWILIO · LIVE SCAVENGER HUNT</div><h1 style="font-size:32px;line-height:1.1">Keep building.</h1><p>Hi ${safeName},</p><p>Thanks for playing. Here are the building blocks behind the experience.</p><p><a href="https://www.twilio.com/docs/video">Video</a> · <a href="https://www.twilio.com/docs/messaging">Messaging</a> · <a href="https://www.twilio.com/docs/segment">Segment</a></p><p>See you at the booth.</p></div>`,
    });
    return 'accepted';
  }

  async dispatchDeliveryJob(jobId, { now = new Date() } = {}) {
    const job = this.store.getDeliveryJob(jobId);
    if (!job || job.channel !== 'sendgrid-guide') return null;
    const lead = this.store.getLead(job.leadId);
    const event = this.store.listEvents().find(item => item.id === job.eventId);
    if (!lead || !event) return null;
    if (!['queued', 'retry', 'waiting-config'].includes(job.status)) return lead.deliveryStatus;
    if (!sendGridReady(this.env)) {
      if (job.status !== 'waiting-config') this.store.updateDeliveryJob(job.id,
        { status: 'waiting-config', lastError: 'SendGrid sender or API key is not configured.', nextAttemptAt: null });
      this.store.updateLeadDelivery(lead.id, 'pending-configuration');
      return 'pending-configuration';
    }
    const claimed = this.store.claimDeliveryJob(job.id, now.toISOString());
    if (!claimed) return this.store.getLead(lead.id)?.deliveryStatus || null;
    try {
      await this.sendGuide({ ...lead, intent: 'guide' }, event, job.id);
      const current = this.store.getDeliveryJob(job.id);
      if (TERMINAL_DELIVERY_STATUSES.has(current?.status) || ['processed', 'deferred'].includes(current?.status))
        return this.store.getLead(lead.id)?.deliveryStatus || current.status;
      this.store.updateDeliveryJob(job.id, { status: 'accepted', lastError: null, nextAttemptAt: null });
      this.store.updateLeadDelivery(lead.id, 'accepted');
      return 'accepted';
    } catch (error) {
      const current = this.store.getDeliveryJob(job.id);
      if (TERMINAL_DELIVERY_STATUSES.has(current?.status) || ['processed', 'deferred'].includes(current?.status))
        return this.store.getLead(lead.id)?.deliveryStatus || current.status;
      const retry = error?.retryable && claimed.attempts < 4;
      const status = retry ? 'retry' : error?.uncertain || !error?.statusCode ? 'needs-review' : 'failed';
      const delayMs = retry ? 30_000 * (4 ** (claimed.attempts - 1)) : 0;
      const nextAttemptAt = retry ? new Date(now.getTime() + delayMs).toISOString() : null;
      const lastError = error?.statusCode ? `SendGrid returned ${error.statusCode}.` : 'SendGrid request outcome is unknown.';
      this.store.updateDeliveryJob(job.id, { status, lastError, nextAttemptAt });
      const leadStatus = status === 'retry' ? 'retrying' : status;
      this.store.updateLeadDelivery(lead.id, leadStatus);
      console.error(`Guide delivery job ${job.id}: ${lastError}`);
      return leadStatus;
    }
  }

  async processDueDeliveryJobs({ now = new Date(), limit = 20 } = {}) {
    if (this.deliverySweepBusy) return 0;
    this.deliverySweepBusy = true;
    try {
      this.store.recoverUncertainDeliveryJobs(new Date(now.getTime() - 120_000).toISOString());
      const jobs = this.store.listDueDeliveryJobs(now.toISOString(), limit);
      for (const job of jobs) await this.dispatchDeliveryJob(job.id, { now });
      return jobs.length;
    } finally { this.deliverySweepBusy = false; }
  }

  verifySendGridSignature({ rawBody, signature, timestamp }) {
    const configured = text(this.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY);
    if (!configured) throw new ValidationError('SendGrid signed webhook verification is not configured.', 'webhook_unconfigured');
    if (!Buffer.isBuffer(rawBody) || !/^\d{10}$/.test(String(timestamp || '')) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(String(signature || '')) ||
        Math.abs(Date.now() - Number(timestamp) * 1000) > 48 * 60 * 60_000)
      throw new ValidationError('Invalid SendGrid signature.', 'forbidden');
    let key;
    try {
      const normalized = configured.replace(/\\n/g, '\n');
      key = normalized.includes('BEGIN PUBLIC KEY') ? createPublicKey(normalized)
        : createPublicKey({ key: Buffer.from(normalized, 'base64'), format: 'der', type: 'spki' });
    } catch { throw new ValidationError('SendGrid webhook verification key is invalid.', 'webhook_unconfigured'); }
    const payload = Buffer.concat([Buffer.from(timestamp), rawBody]);
    const valid = verify('sha256', payload, key, Buffer.from(signature, 'base64'));
    if (!valid) throw new ValidationError('Invalid SendGrid signature.', 'forbidden');
  }

  handleSendGridEvents({ rawBody, signature, timestamp }) {
    this.verifySendGridSignature({ rawBody, signature, timestamp });
    let events;
    try { events = JSON.parse(rawBody.toString('utf8')); }
    catch { throw new ValidationError('Invalid SendGrid event payload.', 'invalid_json'); }
    if (!Array.isArray(events) || events.length > 1000)
      throw new ValidationError('Invalid SendGrid event batch.', 'invalid_json');
    let accepted = 0, ignored = 0;
    this.store.transaction(() => {
      for (const item of events) {
        const eventId = String(item?.sg_event_id || '');
        const deliveryStatus = SENDGRID_EVENT_STATUSES[item?.event];
        const jobId = String(item?.custom_args?.lsh_job_id || item?.lsh_job_id || '');
        if (!eventId || eventId.length > 100 || !deliveryStatus || !jobId || jobId.length > 128) { ignored++; continue; }
        if (!this.store.rememberWebhook(`sendgrid:${eventId}`, 'sendgrid')) { ignored++; continue; }
        const job = this.store.getDeliveryJob(jobId);
        const lead = job && this.store.getLead(job.leadId);
        if (!job || job.channel !== 'sendgrid-guide' || !lead ||
          (item?.email && String(item.email).toLowerCase() !== lead.email.toLowerCase()) ||
          TERMINAL_DELIVERY_STATUSES.has(job.status)) { ignored++; continue; }
        if (job.status === 'deferred' && deliveryStatus === 'processed') { ignored++; continue; }
        this.store.updateDeliveryJob(job.id, { status: deliveryStatus,
          providerMessageId: String(item.sg_message_id || job.providerMessageId || '').slice(0, 200) || null,
          lastError: deliveryStatus === 'bounced' || deliveryStatus === 'dropped'
            ? `SendGrid reported ${deliveryStatus}.` : null });
        this.store.updateLeadDelivery(lead.id, deliveryStatus);
        accepted++;
      }
    });
    return { accepted, ignored };
  }

  publicWebhookUrl(path) {
    if (!this.publicBaseUrl) throw new ValidationError('PUBLIC_BASE_URL is required for signed Twilio webhooks.', 'webhook_unconfigured');
    return new URL(path, this.publicBaseUrl).toString();
  }

  verifyTwilio(path, signature, params) {
    if (!this.env.TWILIO_AUTH_TOKEN || !signature || !this.publicBaseUrl) return false;
    return twilio.validateRequest(this.env.TWILIO_AUTH_TOKEN, signature, this.publicWebhookUrl(path), params);
  }

  _twiml(message) {
    const response = new twilio.twiml.MessagingResponse();
    if (message) response.message(message);
    return response.toString();
  }

  messagingWebhook({ path, signature, params }) {
    if (!this.verifyTwilio(path, signature, params)) return { status: 403, body: 'Invalid Twilio signature.', contentType: 'text/plain' };
    const sid = text(params.MessageSid);
    const from = text(params.From), to = text(params.To), body = text(params.Body);
    if (!sid || !from || !to) return { status: 400, body: 'Missing message fields.', contentType: 'text/plain' };
    if (this.store.hasWebhook(`messaging:${sid}`)) return { status: 200, body: this._twiml('Your ballot has already been counted.'), contentType: 'text/xml' };
    const channel = from.toLowerCase().startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const events = this.store.listEvents().filter(event => event.vote?.enabled && event.vote.channels[channel] &&
      sameSender(to, channel === 'whatsapp' ? event.vote.whatsappSender : event.vote.smsSender, channel));
    const parts = body.toUpperCase().split(/\s+/).filter(Boolean);
    const selected = parts.length === 2 ? events.filter(event => parts[0] === eventCode(event)) : [];
    const event = selected.length === 1 ? selected[0] : null;
    if (!event) return { status: 200, body: this._twiml('Use your event code and the ballot number shown on the screen.'), contentType: 'text/xml' };
    const state = this.engine.snapshot(event.slug).state;
    const choice = parts[1];
    if (!state.vote || state.vote.status !== 'open') {
      return { status: 200, body: this._twiml('There is no open ballot right now. Watch the arena for the next vote.'), contentType: 'text/xml' };
    }
    if (!state.vote.options.some(option => String(option.code).toUpperCase() === choice)) {
      return { status: 200, body: this._twiml('Use the ballot number shown on the screen.'), contentType: 'text/xml' };
    }
    let message;
    try {
      this.engine.castVote(event.slug, {
        windowId: state.vote.id, choice,
        voterHash: this.hashVoter('messaging', from.replace(/^whatsapp:/i, '').replace(/[^+\d]/g, '')),
        channel,
      });
      this.store.rememberWebhook(`messaging:${sid}`, 'messaging');
      message = 'Vote counted. Watch the arena for the result!';
    } catch (error) {
      if (error.code === 'duplicate_vote') message = 'You already voted in this ballot.';
      else if (error.code === 'vote_closed') message = 'That ballot closed. Watch the arena for the next one.';
      else message = 'Use the ballot number shown on the screen.';
    }
    return { status: 200, body: this._twiml(message), contentType: 'text/xml' };
  }

  videoWebhook({ path, signature, params }) {
    if (!this.verifyTwilio(path, signature, params)) return { status: 403, body: 'Invalid Twilio signature.', contentType: 'text/plain' };
    const eventType = text(params.StatusCallbackEvent);
    const identity = text(params.ParticipantIdentity);
    const roomName = text(params.RoomName);
    const roomSid = text(params.RoomSid);
    const participantSid = text(params.ParticipantSid);
    const eventAt = text(params.Timestamp);
    const receiptId = `video:${roomSid}:${text(params.SequenceNumber)}:${eventType}:${identity}:${participantSid}:${eventAt}`;
    if (this.store.hasWebhook(receiptId)) return { status: 200, body: '', contentType: 'text/plain' };
    if (identity.startsWith('p:') && ['participant-connected', 'participant-disconnected'].includes(eventType)) {
      const player = this.store.getPlayer(identity.slice(2));
      const event = player && this.store.listEvents().find(item => item.id === player.eventId);
      if (event && roomName === this.media.roomName(event, player.heat)) {
        const connected = eventType === 'participant-connected';
        if (this.store.acceptVideoParticipantStatus({ roomSid, playerId: player.id,
          participantSid, eventAt, connected })) this.engine.setMediaConnected(event.slug, player.id, connected);
      }
    }
    this.store.rememberWebhook(receiptId, 'video');
    return { status: 200, body: '', contentType: 'text/plain' };
  }

  preflight(event) {
    const isHttps = this.publicBaseUrl.startsWith('https://');
    const messagingEnabled = event.vote.channels.sms || event.vote.channels.whatsapp;
    const messagingReady = Boolean(this.env.TWILIO_AUTH_TOKEN && this.publicBaseUrl &&
      (!event.vote.channels.sms || event.vote.smsSender) &&
      (!event.vote.channels.whatsapp || event.vote.whatsappSender));
    return [
      { name: 'Messaging ballots', status: !messagingEnabled ? 'warning' : messagingReady ? 'ready' : 'warning',
        detail: !messagingEnabled ? 'Web voting is available; SMS and WhatsApp ballots are off.' : messagingReady ? 'Sender and signed webhook settings are present. Test inbound votes and automatic replies.' : 'Set senders, Auth Token, and public URL before enabling message ballots.' },
      { name: 'Segment metrics', status: this.segment ? 'ready' : 'warning',
        detail: this.segment ? 'Server events mirror to Segment.' : 'Local event metrics are active; add a Segment Write Key to mirror them.' },
      { name: 'SendGrid guide', status: sendGridReady(this.env) ? 'ready' : 'warning',
        detail: sendGridReady(this.env) ? 'Guide requests can be submitted to SendGrid. Confirm the sender is verified and test delivery.' : 'Lead capture works locally; add a SendGrid API key and verified From email to submit guides.' },
      { name: 'SendGrid delivery status', status: this.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY ? 'ready' : 'warning',
        detail: this.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY ? 'Signed SendGrid callbacks can confirm delivery and failures.' : 'Add a signed SendGrid Event Webhook and its public verification key to confirm delivery.' },
      { name: 'Public HTTPS', status: isHttps ? 'ready' : 'warning',
        detail: isHttps ? 'Public origin supports phone camera access and signed webhooks.' : 'Use HTTPS for expo phones and Twilio callbacks.' },
    ];
  }

  async close() { await this.segment?.flush?.({ close: true }); }
}

export { eventCode };
