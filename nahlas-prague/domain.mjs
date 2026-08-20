/**
 * Pure, browser-safe domain model for an evidence loop.
 *
 * State changes return a new state. `events` is append-only, authority state
 * never changes observed state, and routing records a receipt only. No API in
 * this module performs network I/O or accepts contact details.
 */

const INITIAL_STATE = Object.freeze({ cases: {}, events: [], hotspotDossiers: {} });

const clone = (value) => JSON.parse(JSON.stringify(value));

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireDate(value, name = 'timestamp') {
  requireText(value, name);
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO-compatible date`);
  return value;
}

function getCase(state, caseId) {
  const incident = state.cases?.[caseId];
  if (!incident) throw new RangeError(`unknown case: ${caseId}`);
  return incident;
}

function appendEvent(state, event) {
  return { ...state, events: [...state.events, Object.freeze(event)] };
}

function replaceCase(state, incident) {
  return { ...state, cases: { ...state.cases, [incident.id]: incident } };
}

function event(type, caseId, source, at, detail = {}) {
  return { type, caseId, source: requireText(source, 'source'), at: requireDate(at), ...detail };
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

/** A deterministic, non-cryptographic receipt hash for comparing immutable payloads. */
export function hashPayload(payload) {
  const text = canonicalize(payload);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a-32:${hash.toString(16).padStart(8, '0')}`;
}

export function createEvidenceLoop() {
  return clone(INITIAL_STATE);
}

/** Register one street-observed incident. Reporter identity is represented only by an opaque witness id. */
export function reportCase(state, { id, category, location, witnessId, evidenceId, observedAt, source = 'reporter' }) {
  requireText(id, 'id');
  if (state.cases[id]) throw new RangeError(`case already exists: ${id}`);
  requireText(category, 'category');
  requireText(location, 'location');
  requireText(witnessId, 'witnessId');
  requireText(evidenceId, 'evidenceId');
  requireDate(observedAt, 'observedAt');

  const incident = {
    id, category, location,
    observedStatus: 'unresolved', authorityStatus: 'unrouted',
    witnesses: { [witnessId]: { id: witnessId, firstSeenAt: observedAt } },
    evidence: { [evidenceId]: { id: evidenceId, observedAt, source } },
    routes: [], rechecks: [],
  };
  return appendEvent(replaceCase(state, incident), event('case.reported', id, source, observedAt, { evidenceId, witnessId }));
}

/** Add a corroboration to one existing incident. This is not an external submission. */
export function corroborateCase(state, caseId, { witnessId, evidenceId, observedAt, source = 'witness' }) {
  const existing = getCase(state, caseId);
  requireText(witnessId, 'witnessId');
  requireText(evidenceId, 'evidenceId');
  requireDate(observedAt, 'observedAt');
  const incident = clone(existing);
  const newWitness = !incident.witnesses[witnessId];
  const newEvidence = !incident.evidence[evidenceId];
  if (newWitness) incident.witnesses[witnessId] = { id: witnessId, firstSeenAt: observedAt };
  if (newEvidence) incident.evidence[evidenceId] = { id: evidenceId, observedAt, source };
  return appendEvent(replaceCase(state, incident), event('case.corroborated', caseId, source, observedAt, {
    witnessId, evidenceId, newWitness, newEvidence,
  }));
}

/** Record an authority closure without claiming the street condition is fixed. */
export function closeByAuthority(state, caseId, { closedAt, source = 'authority', reference } = {}) {
  const existing = getCase(state, caseId);
  const incident = { ...existing, authorityStatus: 'closed' };
  return appendEvent(replaceCase(state, incident), event('authority.closed', caseId, source, closedAt, {
    ...(reference ? { reference: requireText(reference, 'reference') } : {}),
  }));
}

/**
 * Record an evidence-backed street recheck. Only a passing dated recheck may
 * set observedStatus to fixed; a failing recheck leaves it unresolved.
 */
export function recordObservedRecheck(state, caseId, { evidenceId, witnessId, checkedAt, passed, source = 'observer' }) {
  const existing = getCase(state, caseId);
  requireText(evidenceId, 'evidenceId');
  requireText(witnessId, 'witnessId');
  requireDate(checkedAt, 'checkedAt');
  if (typeof passed !== 'boolean') throw new TypeError('passed must be boolean');
  const incident = clone(existing);
  if (!incident.witnesses[witnessId]) incident.witnesses[witnessId] = { id: witnessId, firstSeenAt: checkedAt };
  if (!incident.evidence[evidenceId]) incident.evidence[evidenceId] = { id: evidenceId, observedAt: checkedAt, source };
  incident.rechecks.push({ evidenceId, witnessId, checkedAt, passed, source });
  incident.observedStatus = passed ? 'fixed' : 'unresolved';
  return appendEvent(replaceCase(state, incident), event('observed.rechecked', caseId, source, checkedAt, { evidenceId, witnessId, passed }));
}

/** Store a routing receipt locally. It deliberately does not send a payload. */
export function routeCase(state, caseId, { destination, channel, sentAt, payload, externalReference, source = 'router' }) {
  const existing = getCase(state, caseId);
  requireText(destination, 'destination');
  requireText(channel, 'channel');
  requireDate(sentAt, 'sentAt');
  if (payload === undefined) throw new TypeError('payload is required');
  const receipt = {
    id: `${caseId}:route:${existing.routes.length + 1}`,
    destination, channel, sentAt, payloadHash: hashPayload(payload), status: 'sent',
    ...(externalReference ? { externalReference: requireText(externalReference, 'externalReference') } : {}),
  };
  const incident = { ...existing, authorityStatus: 'routed', routes: [...existing.routes, receipt] };
  return appendEvent(replaceCase(state, incident), event('route.sent', caseId, source, sentAt, { receiptId: receipt.id, payloadHash: receipt.payloadHash }));
}

/** Mark a previously sent receipt as accepted. Sent and accepted remain separate states. */
export function acceptRoute(state, caseId, receiptId, { acceptedAt, source = 'authority', externalReference } = {}) {
  const existing = getCase(state, caseId);
  requireText(receiptId, 'receiptId');
  requireDate(acceptedAt, 'acceptedAt');
  const found = existing.routes.find((receipt) => receipt.id === receiptId);
  if (!found) throw new RangeError(`unknown route receipt: ${receiptId}`);
  if (found.status === 'accepted') throw new RangeError(`route receipt already accepted: ${receiptId}`);
  const receipt = { ...found, status: 'accepted', acceptedAt, ...(externalReference ? { externalReference: requireText(externalReference, 'externalReference') } : {}) };
  const incident = { ...existing, authorityStatus: 'accepted', routes: existing.routes.map((item) => item.id === receiptId ? receipt : item) };
  return appendEvent(replaceCase(state, incident), event('route.accepted', caseId, source, acceptedAt, { receiptId }));
}

/** Group distinct incidents by exact category and location once a threshold is met. */
export function buildHotspotDossiers(state, { threshold = 2, builtAt, source = 'moderator' }) {
  if (!Number.isInteger(threshold) || threshold < 2) throw new RangeError('threshold must be an integer of at least 2');
  requireDate(builtAt, 'builtAt');
  const buckets = new Map();
  Object.values(state.cases).forEach((incident) => {
    const key = `${incident.category}\u0000${incident.location}`;
    buckets.set(key, [...(buckets.get(key) ?? []), incident.id]);
  });
  let next = { ...state, hotspotDossiers: { ...state.hotspotDossiers } };
  for (const [key, memberCaseIds] of buckets) {
    if (memberCaseIds.length < threshold) continue;
    const [category, location] = key.split('\u0000');
    const id = `hotspot:${hashPayload({ category, location, memberCaseIds: [...memberCaseIds].sort() })}`;
    const prior = next.hotspotDossiers[id];
    next.hotspotDossiers[id] = { id, category, location, memberCaseIds: [...memberCaseIds].sort(), threshold, status: 'grouped', builtAt };
    if (!prior || prior.status !== 'grouped') next = appendEvent(next, event('hotspot.grouped', undefined, source, builtAt, { dossierId: id, memberCaseIds: [...memberCaseIds].sort() }));
  }
  return next;
}

/** Reversibly deactivate a hotspot dossier while retaining every member incident and its evidence. */
export function ungroupHotspotDossier(state, dossierId, { ungroupedAt, source = 'moderator' }) {
  requireText(dossierId, 'dossierId');
  const dossier = state.hotspotDossiers?.[dossierId];
  if (!dossier) throw new RangeError(`unknown hotspot dossier: ${dossierId}`);
  if (dossier.status === 'ungrouped') throw new RangeError(`hotspot dossier already ungrouped: ${dossierId}`);
  const updated = { ...dossier, status: 'ungrouped', ungroupedAt: requireDate(ungroupedAt, 'ungroupedAt') };
  const next = { ...state, hotspotDossiers: { ...state.hotspotDossiers, [dossierId]: updated } };
  return appendEvent(next, event('hotspot.ungrouped', undefined, source, ungroupedAt, { dossierId, memberCaseIds: [...dossier.memberCaseIds] }));
}

export function caseSnapshot(state, caseId) {
  return clone(getCase(state, caseId));
}
