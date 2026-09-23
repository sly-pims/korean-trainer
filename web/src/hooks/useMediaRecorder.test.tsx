import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMediaRecorder } from './useMediaRecorder';

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  static instances: FakeMediaRecorder[] = [];
  state: 'inactive' | 'recording' = 'inactive';
  onstop: null | (() => void) = null;
  ondataavailable: null | ((e: { data: Blob }) => void) = null;
  onerror: null | ((e: unknown) => void) = null;
  startCalledWith: unknown = null;
  requestDataCalls = 0;
  deliverData = true;
  constructor() {
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number) {
    this.state = 'recording';
    this.startCalledWith = timeslice;
  }
  requestData() {
    this.requestDataCalls += 1;
  }
  stop() {
    this.state = 'inactive';
    if (this.deliverData) this.ondataavailable?.({ data: new Blob(['audio-bytes']) });
    this.onstop?.();
  }
}

const stream = { getTracks: () => [{ stop: vi.fn() }] };

function stubWebAudio() {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    configurable: true,
  });
}

function lastInstance(): FakeMediaRecorder {
  return FakeMediaRecorder.instances.at(-1)!;
}

describe('useMediaRecorder', () => {
  beforeEach(() => stubWebAudio());
  afterEach(() => {
    FakeMediaRecorder.instances.length = 0;
    vi.unstubAllGlobals();
  });

  it('produces a blob after start->stop (onstop must not be discarded)', async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.recording).toBe(true);

    act(() => {
      result.current.stop();
    });

    expect(result.current.recording).toBe(false);
    expect(result.current.blob).not.toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('starts MediaRecorder with a timeslice so data flows on Android', async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    expect(lastInstance().startCalledWith).toBe(250);
  });

  it('reports a clear error when nothing was recorded', async () => {
    const { result } = renderHook(() => useMediaRecorder());
    await act(async () => {
      await result.current.start();
    });
    lastInstance().deliverData = false;
    act(() => {
      result.current.stop();
    });
    expect(result.current.blob).toBeNull();
    expect(result.current.error).toContain('No audio');
  });
});