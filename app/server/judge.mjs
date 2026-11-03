import jpeg from 'jpeg-js';
import { ValidationError } from './config.mjs';
import { OpenAIVision } from './openai-vision.mjs';

const COLOR_RANGES = {
  red: hue => hue < 16 || hue >= 344,
  orange: hue => hue >= 16 && hue < 43,
  yellow: hue => hue >= 43 && hue < 72,
  green: hue => hue >= 72 && hue < 170,
  blue: hue => hue >= 170 && hue < 265,
  purple: hue => hue >= 265 && hue < 344,
};

function hueAndSaturation(r, g, b) {
  const red = r / 255, green = g / 255, blue = b / 255;
  const top = Math.max(red, green, blue), low = Math.min(red, green, blue), distance = top - low;
  const saturation = top === 0 ? 0 : distance / top;
  let hue = 0;
  if (distance) {
    if (top === red) hue = ((green - blue) / distance) % 6;
    else if (top === green) hue = (blue - red) / distance + 2;
    else hue = (red - green) / distance + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, saturation, brightness: top };
}

export function decodeEvidence(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100 || buffer.length > 150_000 || buffer[0] !== 0xff || buffer[1] !== 0xd8)
    throw new ValidationError('Upload a JPEG under 150 KB.', 'invalid_evidence');
  try {
    const decoded = jpeg.decode(buffer, { useTArray: true, maxResolutionInMP: 2, maxMemoryUsageInMB: 32 });
    if (!decoded || decoded.width < 80 || decoded.height < 80 || decoded.width * decoded.height > 2_000_000)
      throw new Error('Unsupported dimensions');
    return decoded;
  } catch {
    throw new ValidationError('The camera frame could not be read.', 'invalid_evidence');
  }
}

export function detectColor(decoded, target) {
  const matches = COLOR_RANGES[String(target || '').toLowerCase()];
  if (!matches) return { matched: false, confidence: 0, coverage: 0 };
  const { data, width, height } = decoded;
  const xMin = Math.floor(width * 0.17), xMax = Math.ceil(width * 0.83);
  const yMin = Math.floor(height * 0.14), yMax = Math.ceil(height * 0.86);
  const step = Math.max(1, Math.floor(Math.min(width, height) / 180));
  let total = 0, colored = 0;
  for (let y = yMin; y < yMax; y += step) {
    for (let x = xMin; x < xMax; x += step) {
      const index = (y * width + x) * 4;
      const pixel = hueAndSaturation(data[index], data[index + 1], data[index + 2]);
      total++;
      if (pixel.saturation >= 0.44 && pixel.brightness >= 0.2 && matches(pixel.hue)) colored++;
    }
  }
  const coverage = total ? colored / total : 0;
  return { matched: coverage >= 0.075, confidence: Math.max(0, Math.min(1, coverage / 0.22)), coverage };
}

export class JudgeService {
  constructor({ engine, vision = new OpenAIVision(), now = () => Date.now() } = {}) {
    if (!engine) throw new Error('JudgeService needs a GameEngine.');
    this.engine = engine;
    this.vision = vision;
    this.now = now;
    this.samples = new Map();
    this.aiAttempts = new Map();
    this.engine.aiVisionAvailable = this.vision.enabled();
  }

  preflight() {
    return { name: 'AI vision', status: this.vision.enabled() ? 'ready' : 'optional',
      detail: this.vision.enabled() ? 'Server-side image review configured.' : 'Object and text prompts need operator review until an OpenAI key is configured.' };
  }

  async submit({ slug, playerId, buffer, receiptAt = this.now() } = {}) {
    const event = this.engine.event(slug);
    const state = this.engine.store.getRuntime(event.id);
    if (!state || state.paused || !['hunt', 'review'].includes(state.phase) || !state.lockedPlayerIds.includes(playerId))
      return { status: 'ignored', candidate: null };
    const player = this.engine.store.getPlayer(playerId);
    if (!player || ['left', 'kicked'].includes(player.status) ||
      (player.transport === 'twilio' && !player.mediaConnected))
      return { status: 'ignored', candidate: null, reason: 'media_disconnected' };
    if (!state.goAt || receiptAt < Date.parse(state.goAt) || receiptAt > Date.parse(state.roundEndsAt) + 500)
      return { status: 'ignored', candidate: null };
    if (state.promptSnapshot?.judgeMode === 'operator' || state.promptSnapshot?.judgeMode === 'audience')
      return { status: 'manual', candidate: state.candidate };
    if (state.promptSnapshot?.judgeMode === 'ai-assisted' && state.judgeNotice)
      return { status: 'manual', candidate: state.candidate,
        errorCode: state.judgeNotice.code, error: state.judgeNotice.message };
    const decoded = decodeEvidence(buffer);
    const key = `${event.id}:${state.heatId}:${playerId}`;
    const detector = state.promptSnapshot.detector || '';
    const color = detector.startsWith('color:') ? detector.slice(6).trim().toLowerCase() : null;
    if (state.promptSnapshot.judgeMode === 'rule' && color) {
      const result = detectColor(decoded, color);
      const history = (this.samples.get(key) || []).filter(sample => receiptAt - sample.at <= 2500);
      history.push({ at: receiptAt, matched: result.matched });
      this.samples.set(key, history.slice(-4));
      const recent = history.slice(-4);
      const positives = recent.filter(sample => sample.matched);
      if (positives.length >= 3 && positives.at(-1).at - positives[0].at >= 500) {
        const judged = this.engine.acceptJudgment(slug, {
          playerId, matched: true, confidence: Math.max(0.8, result.confidence),
          explanation: `${color} was visible across ${positives.length} recent frames`, source: 'rule', receiptAt,
        });
        const accepted = this.engine.store.getRuntime(event.id)?.candidates.some(item => item.playerId === playerId);
        return { status: accepted ? 'verified' : 'ignored', candidate: judged.candidate, confidence: result.confidence };
      }
      return { status: 'pending', candidate: state.candidate, coverage: result.coverage };
    }
    if (state.promptSnapshot.judgeMode !== 'ai-assisted')
      return { status: 'manual', candidate: state.candidate };
    if (!this.vision.enabled()) {
      const notice = this.engine.reportJudgeUnavailable(slug, { code: 'ai_unconfigured', heatId: state.heatId });
      return { status: 'manual', candidate: state.candidate, errorCode: notice?.code,
        error: notice?.message };
    }
    const lastAttempt = this.aiAttempts.get(key);
    if (lastAttempt && (lastAttempt.inFlight || receiptAt - lastAttempt.at < 1800))
      return { status: 'pending', candidate: state.candidate };
    this.aiAttempts.set(key, { at: receiptAt, inFlight: true });
    let verdict;
    try {
      verdict = await this.vision.judge(buffer, state.promptSnapshot);
    } catch (error) {
      const notice = this.engine.reportJudgeUnavailable(slug, { code: 'ai_unavailable', heatId: state.heatId });
      return { status: 'manual', candidate: this.engine.store.getRuntime(event.id)?.candidate || null,
        errorCode: notice?.code, error: notice?.message };
    } finally {
      this.aiAttempts.set(key, { at: receiptAt, inFlight: false });
      if (this.aiAttempts.size > 2000) this.aiAttempts.clear();
      if (this.samples.size > 2000) this.samples.clear();
    }
    if (!verdict.matched || verdict.confidence < 0.72)
      return { status: 'pending', candidate: this.engine.store.getRuntime(event.id)?.candidate || null, confidence: verdict.confidence };
    const judged = this.engine.acceptJudgment(slug, {
      playerId, matched: true, confidence: verdict.confidence,
      explanation: verdict.explanation, source: 'ai', receiptAt,
    });
    const accepted = this.engine.store.getRuntime(event.id)?.candidates.some(item => item.playerId === playerId);
    return { status: accepted ? 'verified' : 'ignored', candidate: judged.candidate, confidence: verdict.confidence };
  }
}
