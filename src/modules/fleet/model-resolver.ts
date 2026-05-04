/**
 * Pre-flight model validation for fleet backend changes.
 *
 * Background: switch_backend / create_worker / resumeWorker all accept a
 * `model` string from the master agent and used to write it straight into
 * agent_groups + container.json + the shim's worker-backends.json. If the
 * master passed a friendly name like "GLM-5.1" or fat-fingered an id, the
 * write succeeded silently and the failure surfaced minutes later as an
 * SDK "model not available" error from inside the worker container —
 * with no link back to the master that requested the bad value.
 *
 * Fix: the host validates the model against the target backend before
 * persisting. For neuralwatt that means hitting the shim's
 * /models/resolve/<query> endpoint (which already does fuzzy matching and
 * knows the live model catalogue). On success the canonical id replaces
 * the user-provided string. On failure the helper throws so the caller
 * skips persisting and notifies the master with the resolver's message.
 *
 * Claude is pass-through for now — the SDK validates Claude model ids
 * downstream and there's no shim hop where a bad id can poison routing
 * for an entire container's lifetime.
 */
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';

const DEFAULT_SHIM_HOST_URL = 'http://127.0.0.1:3003';
const RESOLVE_TIMEOUT_MS = 5000;

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelResolutionError';
  }
}

/**
 * Validate (and canonicalize) a model id for a backend before persistence.
 *
 * Returns the resolved model id (which may differ from the input, e.g.
 * "GLM-5.1" → "zai-org/GLM-5.1-FP8"), or undefined if no model was
 * supplied. Throws ModelResolutionError if the input is non-empty and the
 * backend can't accept it. Callers must not persist on throw.
 */
export async function resolveModelForBackend(backend: string, model: string | undefined): Promise<string | undefined> {
  if (!model || model.trim() === '') return undefined;
  const trimmed = model.trim();
  if (backend !== 'neuralwatt') return trimmed;
  return await resolveNeuralwattModel(trimmed);
}

async function resolveNeuralwattModel(model: string): Promise<string> {
  const baseUrl = shimHostUrl();
  const url = `${baseUrl.replace(/\/$/, '')}/models/resolve/${encodeURIComponent(model)}`;
  let resp: Response;
  try {
    // Bounded timeout: model resolution is a local HTTP hop. Without a
    // timeout, a hung shim (accepting connections but not responding —
    // distinct from a dead shim, which fails fast with ECONNREFUSED) would
    // block the calling fleet handler indefinitely, freezing the master
    // agent's turn with no error to surface.
    resp = await fetch(url, { signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
  } catch (err) {
    const reason =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? `did not respond within ${RESOLVE_TIMEOUT_MS}ms`
        : `was unreachable (${String(err)})`;
    throw new ModelResolutionError(
      `Neuralwatt shim at ${baseUrl} ${reason} when validating model "${model}". ` +
        `Check the shim (systemctl --user status nanoclaw-shim) and retry, or check NW_SHIM_HOST_URL.`,
    );
  }
  let body: { model?: string; match?: string; error?: string; candidates?: string[] } = {};
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    // Fall through with empty body; error message will reflect status only.
  }
  if (resp.ok && body.model) {
    if (body.model !== model) {
      log.info('Neuralwatt model resolved', { requested: model, resolved: body.model, match: body.match });
    }
    return body.model;
  }
  if (resp.status === 404) {
    const cands = body.candidates && body.candidates.length > 0 ? ` Candidates: ${body.candidates.join(', ')}` : '';
    throw new ModelResolutionError(
      `Neuralwatt model "${model}" not found.${cands} Use a name from /models or pick one of the candidates above.`,
    );
  }
  if (resp.status === 503) {
    throw new ModelResolutionError(
      `Neuralwatt shim has no model catalogue available right now (503${body.error ? `: ${body.error}` : ''}). ` +
        `The shim may have just started or upstream is unreachable. Retry in a few seconds.`,
    );
  }
  throw new ModelResolutionError(
    `Neuralwatt shim refused to resolve "${model}" (HTTP ${resp.status}${body.error ? `: ${body.error}` : ''}).`,
  );
}

function shimHostUrl(): string {
  const fromProcess = process.env.NW_SHIM_HOST_URL;
  if (fromProcess) return fromProcess;
  const fromEnvFile = readEnvFile(['NW_SHIM_HOST_URL']).NW_SHIM_HOST_URL;
  return fromEnvFile ?? DEFAULT_SHIM_HOST_URL;
}
