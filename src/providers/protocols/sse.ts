import type { ProtocolRawEvent } from './types';

export class SseParser {
  private line: number[] = [];
  private eventBytes: number[] = [];
  private dataLines: string[] = [];
  private eventName: string | undefined;
  private lastEventId: string | undefined;
  private retry: number | undefined;
  private decodeError: string | undefined;
  private previousWasCarriageReturn = false;
  private pendingCarriageReturnFrame = false;
  private firstLine = true;

  push(chunk: Uint8Array): ProtocolRawEvent[] {
    const emitted: ProtocolRawEvent[] = [];

    for (const byte of chunk) {
      if (this.previousWasCarriageReturn) {
        this.previousWasCarriageReturn = false;
        if (byte === 0x0a) {
          this.eventBytes.push(byte);
          if (this.pendingCarriageReturnFrame) {
            this.emitEvent(emitted, true);
            this.pendingCarriageReturnFrame = false;
          }
          continue;
        }
        if (this.pendingCarriageReturnFrame) {
          this.emitEvent(emitted, true);
          this.pendingCarriageReturnFrame = false;
        }
      }

      this.eventBytes.push(byte);
      if (byte === 0x0d) {
        this.pendingCarriageReturnFrame = this.readLine();
        this.previousWasCarriageReturn = true;
      } else if (byte === 0x0a) {
        if (this.readLine()) {
          this.emitEvent(emitted, true);
        }
      } else {
        this.line.push(byte);
      }
    }

    return emitted;
  }

  finish(): ProtocolRawEvent[] {
    const emitted: ProtocolRawEvent[] = [];

    if (this.pendingCarriageReturnFrame) {
      this.emitEvent(emitted, true);
      this.pendingCarriageReturnFrame = false;
    }
    if (this.line.length > 0) {
      this.readLine();
    }
    if (this.eventBytes.length > 0) {
      this.emitEvent(emitted, false);
    }

    return emitted;
  }

  private readLine(): boolean {
    let value: string;
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(this.line),
      );
    } catch {
      value = new TextDecoder('utf-8').decode(Uint8Array.from(this.line));
      this.decodeError = 'SSE line contains invalid UTF-8.';
    }
    this.line = [];

    if (this.firstLine) {
      this.firstLine = false;
      if (value.startsWith('\uFEFF')) {
        value = value.slice(1);
      }
    }

    if (value.length === 0) {
      return true;
    }
    if (value.startsWith(':')) {
      return false;
    }

    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let fieldValue = colon < 0 ? '' : value.slice(colon + 1);
    if (fieldValue.startsWith(' ')) {
      fieldValue = fieldValue.slice(1);
    }

    switch (field) {
      case 'data':
        this.dataLines.push(fieldValue);
        break;
      case 'event':
        this.eventName = fieldValue;
        break;
      case 'id':
        if (!fieldValue.includes('\u0000')) {
          this.lastEventId = fieldValue;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(fieldValue)) {
          this.retry = Number(fieldValue);
        }
        break;
      default:
        break;
    }

    return false;
  }

  private emitEvent(
    emitted: ProtocolRawEvent[],
    frameTerminated: boolean,
  ): void {
    const event: ProtocolRawEvent = {
      event: this.eventName || 'message',
      data: this.dataLines.join('\n'),
      dataLines: [...this.dataLines],
      frameTerminated,
      rawBytes: Uint8Array.from(this.eventBytes),
    };
    if (this.lastEventId !== undefined) {
      event.id = this.lastEventId;
    }
    if (this.retry !== undefined) {
      event.retry = this.retry;
    }
    if (this.decodeError !== undefined) {
      event.parseError = this.decodeError;
    }
    emitted.push(event);

    this.eventBytes = [];
    this.dataLines = [];
    this.eventName = undefined;
    this.decodeError = undefined;
  }
}
