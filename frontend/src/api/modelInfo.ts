import type { ModelInfo } from '../types';

export type ModelInfoStatus = 'ok' | 'unavailable' | 'not_evaluated';

export interface ModelInfoResult {
  status: ModelInfoStatus;
  data?: ModelInfo;
  source: string;
  checkedAt: string;
  error?: string;
}

export interface FetchModelInfoOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  endpoint?: string;
}

function hasEvaluatedMetrics(payload: unknown): payload is ModelInfo {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Partial<ModelInfo>;
  const perFault = candidate.metrics?.per_fault;
  const overall = candidate.metrics?.overall;
  return Boolean(
    typeof candidate.version === 'string' &&
      overall &&
      typeof overall.precision === 'number' &&
      typeof overall.recall === 'number' &&
      perFault &&
      Object.keys(perFault).length > 0,
  );
}

/**
 * Fetch active ML model metadata, held-out evaluation metrics, and PSI drift state
 * from /model/info with an explicit timeout and honest status discrimination.
 * Never returns invented or hardcoded placeholder metrics when unavailable.
 */
export async function fetchModelInfo(
  options: FetchModelInfoOptions = {},
): Promise<ModelInfoResult> {
  const { timeoutMs = 4500, signal, endpoint } = options;
  const baseUrl = import.meta.env.VITE_ML_SERVICE_URL
    ? String(import.meta.env.VITE_ML_SERVICE_URL).replace(/\/$/, '')
    : '';
  const url = endpoint || `${baseUrl}/model/info`;
  const sourceLabel = endpoint || '/model/info';
  const checkedAt = new Date().toISOString();

  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        status: 'unavailable',
        source: sourceLabel,
        checkedAt,
        error: `ML service returned HTTP ${res.status}`,
      };
    }

    const contentType = res.headers?.get?.('content-type') || '';
    if (contentType && !contentType.includes('application/json')) {
      return {
        status: 'unavailable',
        source: sourceLabel,
        checkedAt,
        error: 'Non-JSON response from /model/info',
      };
    }

    const payload = (await res.json()) as unknown;
    if (!hasEvaluatedMetrics(payload)) {
      return {
        status: 'not_evaluated',
        data:
          payload && typeof payload === 'object' ? (payload as ModelInfo) : undefined,
        source: sourceLabel,
        checkedAt,
        error: 'Model evaluation metrics are missing from /model/info',
      };
    }

    return {
      status: 'ok',
      data: payload,
      source: sourceLabel,
      checkedAt,
    };
  } catch (err) {
    const message = timedOut
      ? `Timed out after ${timeoutMs}ms reaching ${sourceLabel}`
      : err instanceof Error
        ? err.message
        : 'Unable to reach /model/info';
    return {
      status: 'unavailable',
      source: sourceLabel,
      checkedAt,
      error: message,
    };
  } finally {
    globalThis.clearTimeout(timer);
    if (signal) {
      signal.removeEventListener('abort', onExternalAbort);
    }
  }
}
