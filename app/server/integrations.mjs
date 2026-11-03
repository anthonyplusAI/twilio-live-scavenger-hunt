import { createHmac, randomBytes } from 'node:crypto';
import twilio from 'twilio';
import { Analytics } from '@segment/analytics-node';
import { ValidationError } from './config.mjs';

const safeMetricKeys = new Set([
  'heatId', 'heat', 'playerId', 'playerCount', 'queued', 'promptId', 'category',
  'channel', 'windowType', 'windowId', 'choice', 'source',
  'isOverride', 'timeToMatchMs', 'candidateCount', 'votes', 'promoted',
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
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: message.from }, subject: message.subject,
        content: [
          { type: 'text/plain', value: message.text },
          { type: 'text/html', value: message.html },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`SendGrid returned ${response.status}.`);
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
      this.segment.track({
        anonymousId: item.properties?.playerId || item.properties?.voterId || item.eventId,
        event: item.type, properties, timestamp: item.at,
      });
    } catch (error) { console.error(`Segment track: ${error.message}`); }
  }

  async sendGuide(lead, event) {
    if (lead.intent !== 'guide') return 'operator-follow-up';
    if (!lead.email) return 'pending-email';
    if (!this.env.SENDGRID_API_KEY || !this.env.SENDGRID_FROM_EMAIL) return 'pending-configuration';
    try {
      const safeName = String(lead.name || 'there').replace(/[<>&"']/g, '').slice(0, 80);
      await this.sendgrid.send({
        to: lead.email, from: this.env.SENDGRID_FROM_EMAIL,
        subject: `Your ${event.name} build guide`,
        text: `Hi ${safeName},\n\nThanks for playing Live Scavenger Hunt. Explore how to build your own real-time experience with Twilio Video, Messaging, and Segment:\n\nVideo: https://www.twilio.com/docs/video\nMessaging: https://www.twilio.com/docs/messaging\nSegment: https://www.twilio.com/docs/segment\n\nIf you requested an expert, the booth team can follow up separately.\n`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px;color:#172042"><div style="font-weight:800;letter-spacing:.15em;color:#e2231a">TWILIO · LIVE SCAVENGER HUNT</div><h1 style="font-size:32px;line-height:1.1">Keep building.</h1><p>Hi ${safeName},</p><p>Thanks for playing. Here are the building blocks behind the experience.</p><p><a href="https://www.twilio.com/docs/video">Video</a> · <a href="https://www.twilio.com/docs/messaging">Messaging</a> · <a href="https://www.twilio.com/docs/segment">Segment</a></p><p>See you at the booth.</p></div>`,
      });
      return 'sent';
    } catch (error) {
      console.error(`Guide delivery: ${error.message}`);
      return 'failed';
    }
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
    const receiptId = `video:${text(params.RoomSid)}:${text(params.SequenceNumber)}:${eventType}:${identity}`;
    if (this.store.hasWebhook(receiptId)) return { status: 200, body: '', contentType: 'text/plain' };
    if (identity.startsWith('p:') && ['participant-connected', 'participant-disconnected'].includes(eventType)) {
      const player = this.store.getPlayer(identity.slice(2));
      const event = player && this.store.listEvents().find(item => item.id === player.eventId);
      if (event && roomName === this.media.roomName(event, player.heat)) {
        this.engine.setMediaConnected(event.slug, player.id, eventType === 'participant-connected');
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
      { name: 'SendGrid guide', status: this.env.SENDGRID_API_KEY && this.env.SENDGRID_FROM_EMAIL ? 'ready' : 'warning',
        detail: this.env.SENDGRID_API_KEY && this.env.SENDGRID_FROM_EMAIL ? 'Requested guide emails are configured.' : 'Lead capture works locally; add SendGrid to deliver requested guides.' },
      { name: 'Public HTTPS', status: isHttps ? 'ready' : 'warning',
        detail: isHttps ? 'Public origin supports phone camera access and signed webhooks.' : 'Use HTTPS for expo phones and Twilio callbacks.' },
    ];
  }

  async close() { await this.segment?.flush?.({ close: true }); }
}

export { eventCode };
