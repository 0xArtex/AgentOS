import { v4 as uuid } from "uuid";
import { config } from "../config";
import { storage } from "./storage";

const TELNYX_API = "https://api.telnyx.com/v2";

function headers() {
  if (!config.telnyxApiKey) throw new Error("Telnyx API key not configured");
  return {
    Authorization: `Bearer ${config.telnyxApiKey}`,
    "Content-Type": "application/json",
  };
}

async function telnyx(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${TELNYX_API}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as any;
  if (!res.ok) {
    const msg = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || JSON.stringify(data);
    throw new Error(`${res.status} ${msg}`);
  }
  return data.data || data;
}

// ── Call Types ─────────────────────────────────────────────────

export interface CallRecord {
  id: string;
  callControlId: string;
  callLegId: string;
  phoneNumberId: string;
  from: string;
  to: string;
  direction: "outbound" | "inbound";
  status: string;
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  duration?: number;
  recordingUrl?: string;
}

// ── Dial (outbound call) ──────────────────────────────────────

export async function dial(
  phoneNumberId: string,
  to: string,
  opts?: {
    tts?: string;
    ttsVoice?: string;
    audioUrl?: string;
    webhookUrl?: string;
    timeoutSecs?: number;
    record?: boolean;
  }
): Promise<CallRecord> {
  const number = storage.getPhoneNumber(phoneNumberId);
  if (!number) throw new Error(`Phone number ${phoneNumberId} not found`);
  if (!number.active) throw new Error("Phone number is deactivated");

  const webhookUrl = opts?.webhookUrl || `https://palmyr.ai/phone/webhooks/voice`;

  if (!config.telnyxVoiceAppId) {
    throw new Error("Voice not configured — set TELNYX_VOICE_APP_ID");
  }

  const payload: any = {
    connection_id: config.telnyxVoiceAppId,
    to,
    from: number.phoneNumber,
    webhook_url: webhookUrl,
    webhook_url_method: "POST",
    timeout_secs: opts?.timeoutSecs || 30,
  };

  const result = await telnyx("POST", "/calls", payload);

  const record: CallRecord = {
    id: uuid(),
    callControlId: result.call_control_id,
    callLegId: result.call_leg_id || result.call_control_id,
    phoneNumberId,
    from: number.phoneNumber,
    to,
    direction: "outbound",
    status: "initiated",
    startedAt: new Date().toISOString(),
  };

  // Store call record
  storage.setCall(record.id, record);

  // Queue post-answer actions as ONE composite record — there is a single
  // storage slot per callControlId, so writing tts/audio/record separately let
  // the last one clobber the others (e.g. tts+record dropped the TTS).
  if (opts?.tts || opts?.audioUrl || opts?.record) {
    storage.setCallPendingAction(record.callControlId, {
      tts: opts.tts ? { text: opts.tts, voice: opts.ttsVoice || "female" } : undefined,
      audioUrl: opts.audioUrl,
      record: !!opts.record,
    });
  }

  return record;
}

// ── Call Control Commands ──────────────────────────────────────

export async function speakText(
  callControlId: string,
  text: string,
  voice: string = "female",
  language: string = "en-US"
): Promise<void> {
  await telnyx("POST", `/calls/${callControlId}/actions/speak`, {
    payload: text,
    voice,
    language,
  });
}

export async function playAudio(
  callControlId: string,
  audioUrl: string
): Promise<void> {
  await telnyx("POST", `/calls/${callControlId}/actions/playback_start`, {
    audio_url: audioUrl,
  });
}

export async function stopAudio(callControlId: string): Promise<void> {
  await telnyx("POST", `/calls/${callControlId}/actions/playback_stop`, {});
}

export async function sendDtmf(
  callControlId: string,
  digits: string
): Promise<void> {
  await telnyx("POST", `/calls/${callControlId}/actions/send_dtmf`, {
    digits,
    duration_millis: 250,
  });
}

export async function startRecording(
  callControlId: string,
  format: string = "mp3"
): Promise<void> {
  await telnyx("POST", `/calls/${callControlId}/actions/record_start`, {
    format,
    channels: "single",
  });
}

export async function stopRecording(callControlId: string): Promise<void> {
  await telnyx("POST", `/calls/${callControlId}/actions/record_stop`, {});
}

export async function hangup(callControlId: string): Promise<void> {
  await telnyx("POST", `/calls/${callControlId}/actions/hangup`, {});
}

export async function answer(callControlId: string): Promise<void> {
  await telnyx("POST", `/calls/${callControlId}/actions/answer`, {});
}

export async function reject(callControlId: string): Promise<void> {
  await telnyx("POST", `/calls/${callControlId}/actions/reject`, {});
}

export async function transfer(
  callControlId: string,
  to: string
): Promise<void> {
  await telnyx("POST", `/calls/${callControlId}/actions/transfer`, {
    to,
  });
}

export async function gatherDtmf(
  callControlId: string,
  opts?: {
    minDigits?: number;
    maxDigits?: number;
    timeoutMillis?: number;
    terminatingDigit?: string;
    prompt?: string;
    promptVoice?: string;
  }
): Promise<void> {
  const payload: any = {
    minimum_digits: opts?.minDigits || 1,
    maximum_digits: opts?.maxDigits || 10,
    timeout_millis: opts?.timeoutMillis || 10000,
    terminating_digit: opts?.terminatingDigit || "#",
    valid_digits: "0123456789*#",
  };

  // If a TTS prompt is provided, speak it first
  if (opts?.prompt) {
    await speakText(callControlId, opts.prompt, opts?.promptVoice || "female");
  }

  await telnyx("POST", `/calls/${callControlId}/actions/gather`, payload);
}

// ── Call Lookup ────────────────────────────────────────────────

export function getCall(callId: string): CallRecord | undefined {
  return storage.getCall(callId);
}

export function getCallByControlId(callControlId: string): CallRecord | undefined {
  return storage.getCallByControlId(callControlId);
}

export function listCalls(phoneNumberId: string): CallRecord[] {
  return storage.listCalls(phoneNumberId);
}

// ── Webhook Handler ───────────────────────────────────────────

export async function handleCallEvent(event: any): Promise<void> {
  const eventType = event.event_type;
  const payload = event.payload;
  const callControlId = payload?.call_control_id;

  if (!callControlId) return;

  const call = storage.getCallByControlId(callControlId);

  switch (eventType) {
    case "call.initiated":
      if (call) {
        call.status = "ringing";
        storage.setCall(call.id, call);
      }
      break;

    case "call.answered":
      if (call) {
        call.status = "answered";
        call.answeredAt = new Date().toISOString();
        storage.setCall(call.id, call);

        // Execute every queued sub-action (TTS, then audio, then record).
        const pending = storage.getCallPendingAction(callControlId);
        if (pending) {
          try {
            if (pending.tts) {
              await speakText(callControlId, pending.tts.text, pending.tts.voice);
            }
            if (pending.audioUrl) {
              await playAudio(callControlId, pending.audioUrl);
            }
            if (pending.record) {
              await startRecording(callControlId);
            }
          } catch (e: any) {
            console.error("[voice] Pending action failed:", e.message);
          }
          storage.clearCallPendingAction(callControlId);
        }
      }
      break;

    case "call.hangup":
      if (call) {
        call.status = "ended";
        call.endedAt = new Date().toISOString();
        if (call.answeredAt) {
          call.duration = Math.round(
            (new Date(call.endedAt).getTime() - new Date(call.answeredAt).getTime()) / 1000
          );
        }
        storage.setCall(call.id, call);
      }
      break;

    case "call.recording.saved":
      if (call && payload?.recording_urls) {
        call.recordingUrl = payload.recording_urls.mp3 || payload.recording_urls.wav;
        storage.setCall(call.id, call);
      }
      break;

    case "call.gather.ended":
      // DTMF input collected — store for agent to retrieve
      if (call && payload?.digits) {
        storage.setCallGatheredDigits(callControlId, payload.digits);
      }
      break;

    default:
      console.log(`[voice] Unhandled event: ${eventType}`);
  }
}
