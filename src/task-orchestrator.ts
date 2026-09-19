import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export type TaskCondition = { nodeId: string; field: string; equals: JsonScalar };
export type TaskNode = { id: string; tool: string; dependsOn: string[]; condition: TaskCondition | null;
  input: { [key: string]: JsonValue } };
export type TaskPlan = { id: string; version: number; goal: string; nodes: TaskNode[] };

export type TaskToolRisk = 'read' | 'sensitive_read' | 'preview' | 'write';
export type TaskToolContext = { plan: TaskPlan; node: TaskNode; dependencyOutputs: Readonly<Record<string, Readonly<Record<string, JsonValue>>>> };
export type TaskTool = { risk: TaskToolRisk; timeoutMs: number; maxAttempts: number;
  validateInput: (input: Readonly<Record<string, JsonValue>>) => void;
  execute: (context: TaskToolContext, signal: AbortSignal) => Promise<Record<string, JsonValue>> };
export type TaskToolRegistry = Readonly<Record<string, TaskTool>>;

export type TaskNodeStatus = 'pending' | 'running' | 'waiting_confirmation' | 'succeeded' | 'skipped' | 'failed';
export type TaskStatus = 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';
export type TaskNodeState = { status: TaskNodeStatus; attempts: number; output?: Record<string, JsonValue>;
  error?: 'TOOL_FAILED' | 'TOOL_TIMEOUT' | 'WRITE_RESULT_UNKNOWN'; startedAt?: string; completedAt?: string };
export type TaskState = { planId: string; planVersion: number; status: TaskStatus; createdAt: string; updatedAt: string;
  nodes: Record<string, TaskNodeState> };
export type TaskAuthorization = { planId: string; planVersion: number; nodeId: string; previewFingerprint: string; expiresAt: number; proof: string };
export type TaskEvent = { type: 'task.status' | 'node.started' | 'node.completed' | 'node.failed' | 'node.skipped';
  taskStatus?: TaskStatus; nodeId?: string; code?: string };

const MAX_NODES = 16, MAX_PLAN_BYTES = 64 * 1024, MAX_INPUT_BYTES = 8 * 1024, MAX_OUTPUT_BYTES = 64 * 1024;
const identifier = /^[a-z][a-z0-9_-]{0,63}$/;
const fieldName = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

const jsonBytes = (value: unknown) => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('TASK_NON_JSON');
  return Buffer.byteLength(encoded);
};

const plainRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const scalar = (value: unknown): value is JsonScalar => value === null || typeof value === 'string' || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value));
const jsonValue = (value: unknown): value is JsonValue => scalar(value)
  || (Array.isArray(value) && value.every(jsonValue))
  || (plainRecord(value) && Object.values(value).every(jsonValue));

function stable(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function fingerprint(value: JsonValue) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

/** Validate an untrusted LLM-produced plan against the backend-owned tool registry. */
export function validateTaskPlan(value: unknown, registry: TaskToolRegistry): TaskPlan {
  if (!plainRecord(value) || jsonBytes(value) > MAX_PLAN_BYTES || !identifier.test(String(value.id ?? ''))
    || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > 1000
    || !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > MAX_NODES) throw new Error('TASK_PLAN_INVALID');
  const nodes: TaskNode[] = value.nodes.map(raw => {
    if (!plainRecord(raw) || !identifier.test(String(raw.id ?? '')) || typeof raw.tool !== 'string'
      || !Object.prototype.hasOwnProperty.call(registry, raw.tool)
      || !Array.isArray(raw.dependsOn) || raw.dependsOn.some(dep => typeof dep !== 'string' || !identifier.test(dep))
      || !plainRecord(raw.input) || !jsonValue(raw.input) || jsonBytes(raw.input) > MAX_INPUT_BYTES) throw new Error('TASK_NODE_INVALID');
    let condition: TaskCondition | null = null;
    if (raw.condition !== null) {
      if (!plainRecord(raw.condition) || !identifier.test(String(raw.condition.nodeId ?? ''))
        || !fieldName.test(String(raw.condition.field ?? '')) || !scalar(raw.condition.equals)) throw new Error('TASK_CONDITION_INVALID');
      condition = { nodeId: String(raw.condition.nodeId), field: String(raw.condition.field), equals: raw.condition.equals };
    }
    registry[raw.tool].validateInput(raw.input as Record<string, JsonValue>);
    return { id: String(raw.id), tool: raw.tool, dependsOn: [...raw.dependsOn], condition,
      input: structuredClone(raw.input) as Record<string, JsonValue> };
  });
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length) throw new Error('TASK_NODE_DUPLICATE');
  for (const node of nodes) {
    if (node.dependsOn.includes(node.id) || node.dependsOn.some(dep => !ids.has(dep))) throw new Error('TASK_DEPENDENCY_INVALID');
    if (new Set(node.dependsOn).size !== node.dependsOn.length) throw new Error('TASK_DEPENDENCY_DUPLICATE');
    if (node.condition && !node.dependsOn.includes(node.condition.nodeId)) throw new Error('TASK_CONDITION_DEPENDENCY');
    const tool = registry[node.tool];
    if (!Number.isInteger(tool.timeoutMs) || tool.timeoutMs < 10 || tool.timeoutMs > 120_000
      || !Number.isInteger(tool.maxAttempts) || tool.maxAttempts < 1 || tool.maxAttempts > 3
      || (tool.risk === 'write' && tool.maxAttempts !== 1)) throw new Error('TASK_TOOL_POLICY_INVALID');
    if (tool.risk === 'write' && !node.dependsOn.some(dep => registry[nodes.find(candidate => candidate.id === dep)!.tool].risk === 'preview'))
      throw new Error('TASK_WRITE_WITHOUT_PREVIEW');
  }
  const visiting = new Set<string>(), visited = new Set<string>(), byId = new Map(nodes.map(node => [node.id, node]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('TASK_DEPENDENCY_CYCLE');
    if (visited.has(id)) return;
    visiting.add(id); for (const dep of byId.get(id)!.dependsOn) visit(dep); visiting.delete(id); visited.add(id);
  };
  for (const node of nodes) visit(node.id);
  return { id: String(value.id), version: Number(value.version), goal: value.goal.trim(), nodes };
}

export function createTaskState(plan: TaskPlan, now = Date.now()): TaskState {
  const timestamp = new Date(now).toISOString();
  return { planId: plan.id, planVersion: plan.version, status: 'paused', createdAt: timestamp, updatedAt: timestamp,
    nodes: Object.fromEntries(plan.nodes.map(node => [node.id, { status: 'pending', attempts: 0 }])) };
}

export class ConditionalTaskOrchestrator {
  private authorizationKey = randomBytes(32);
  private active = new Map<string, { controller: AbortController; plan: TaskPlan }>();
  constructor(private registry: TaskToolRegistry, private maxParallel = 4, private now = Date.now,
    private emit?: (event: TaskEvent) => void) {
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw new Error('TASK_PARALLELISM_INVALID');
  }

  validate(value: unknown) { return validateTaskPlan(value, this.registry); }

  private previewFingerprint(plan: TaskPlan, state: TaskState, node: TaskNode) {
    const previews = node.dependsOn.filter(dep => this.registry[plan.nodes.find(candidate => candidate.id === dep)!.tool].risk === 'preview')
      .map(dep => ({ id: dep, output: state.nodes[dep].output ?? null }));
    if (!previews.length || previews.some(item => state.nodes[item.id].status !== 'succeeded')) throw new Error('TASK_PREVIEW_NOT_READY');
    return fingerprint(previews as unknown as JsonValue);
  }

  authorize(planValue: unknown, state: TaskState, nodeId: string, ttlMs = 5 * 60_000): TaskAuthorization {
    const plan = this.validate(planValue), node = plan.nodes.find(candidate => candidate.id === nodeId);
    if (!node || this.registry[node.tool].risk !== 'write' || state.nodes[nodeId]?.status !== 'waiting_confirmation'
      || !Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60_000) throw new Error('TASK_AUTHORIZATION_INVALID');
    const authorization = { planId: plan.id, planVersion: plan.version, nodeId,
      previewFingerprint: this.previewFingerprint(plan, state, node), expiresAt: this.now() + ttlMs };
    return { ...authorization, proof: this.signAuthorization(authorization) };
  }

  cancel(state: TaskState) {
    if (!['completed', 'failed', 'cancelled'].includes(state.status)) {
      const active = this.active.get(`${state.planId}:${state.planVersion}`);
      const uncertainWrite = active?.plan.nodes.some(node => state.nodes[node.id]?.status === 'running'
        && this.registry[node.tool].risk === 'write') ?? false;
      active?.controller.abort(); state.status = uncertainWrite ? 'failed' : 'cancelled';
      state.updatedAt = new Date(this.now()).toISOString();
      this.emit?.({ type: 'task.status', taskStatus: state.status });
    }
  }

  /** Audit/persistence view. Sensitive tool outputs such as exact GPS are never included. */
  snapshot(planValue: unknown, state: TaskState): TaskState {
    const plan = this.validate(planValue);
    this.assertState(plan, state);
    return { ...structuredClone(state), nodes: Object.fromEntries(plan.nodes.map(node => {
      const current = structuredClone(state.nodes[node.id]);
      if (this.registry[node.tool].risk === 'sensitive_read') delete current.output;
      return [node.id, current];
    })) };
  }

  async execute(planValue: unknown, state = createTaskState(this.validate(planValue), this.now()),
    authorizations: readonly TaskAuthorization[] = [], signal = new AbortController().signal): Promise<TaskState> {
    const plan = this.validate(planValue); this.assertState(plan, state);
    if (['completed', 'failed', 'cancelled'].includes(state.status)) return state;
    const activeKey = `${plan.id}:${plan.version}`;
    if (this.active.has(activeKey)) throw new Error('TASK_ALREADY_RUNNING');
    const controller = new AbortController(), runSignal = AbortSignal.any([signal, controller.signal]);
    this.active.set(activeKey, { controller, plan });
    try {
    state.status = 'running'; this.touch(state); this.emit?.({ type: 'task.status', taskStatus: 'running' });
    const byId = new Map(plan.nodes.map(node => [node.id, node]));
    while (state.status === 'running') {
      if (runSignal.aborted) { state.status = 'paused'; this.touch(state); break; }
      let changed = false;
      for (const node of plan.nodes) {
        const current = state.nodes[node.id];
        if (!['pending', 'waiting_confirmation'].includes(current.status)) continue;
        const dependencies = node.dependsOn.map(dep => state.nodes[dep]);
        if (dependencies.some(dep => dep.status === 'failed' || dep.status === 'skipped')) {
          current.status = 'skipped'; current.completedAt = new Date(this.now()).toISOString(); changed = true;
          this.emit?.({ type: 'node.skipped', nodeId: node.id, code: 'DEPENDENCY_UNAVAILABLE' }); continue;
        }
        if (dependencies.some(dep => dep.status !== 'succeeded')) continue;
        if (node.condition) {
          const output = state.nodes[node.condition.nodeId].output;
          if (!output || !Object.prototype.hasOwnProperty.call(output, node.condition.field)
            || output[node.condition.field] !== node.condition.equals) {
            current.status = 'skipped'; current.completedAt = new Date(this.now()).toISOString(); changed = true;
            this.emit?.({ type: 'node.skipped', nodeId: node.id, code: 'CONDITION_FALSE' }); continue;
          }
        }
        if (this.registry[node.tool].risk === 'write') {
          const expected = this.previewFingerprint(plan, state, node);
          const authorized = authorizations.some(value => value.planId === plan.id && value.planVersion === plan.version
            && value.nodeId === node.id && value.expiresAt > this.now() && value.previewFingerprint === expected
            && this.validAuthorization(value));
          if (!authorized) { current.status = 'waiting_confirmation'; changed = true; }
          else if (current.status === 'waiting_confirmation') { current.status = 'pending'; changed = true; }
        }
      }
      const ready = plan.nodes.filter(node => state.nodes[node.id].status === 'pending'
        && node.dependsOn.every(dep => state.nodes[dep].status === 'succeeded'));
      const reads = ready.filter(node => this.registry[node.tool].risk !== 'write');
      const wave = reads.length ? reads.slice(0, this.maxParallel) : ready.filter(node => this.registry[node.tool].risk === 'write').slice(0, 1);
      if (wave.length) {
        await Promise.all(wave.map(node => this.executeNode(plan, state, node, byId, runSignal)));
        if (runSignal.aborted && state.status === 'running') state.status = 'paused';
        this.touch(state); continue;
      }
      const statuses = Object.values(state.nodes).map(node => node.status);
      if (statuses.some(status => status === 'waiting_confirmation')) state.status = 'waiting_confirmation';
      else if (statuses.some(status => status === 'failed')) state.status = 'failed';
      else if (statuses.every(status => status === 'succeeded' || status === 'skipped')) state.status = 'completed';
      else if (!changed) state.status = 'paused';
      this.touch(state);
    }
    this.emit?.({ type: 'task.status', taskStatus: state.status }); return state;
    } finally { this.active.delete(activeKey); }
  }

  private async executeNode(plan: TaskPlan, state: TaskState, node: TaskNode, byId: Map<string, TaskNode>, signal: AbortSignal) {
    const policy = this.registry[node.tool], current = state.nodes[node.id];
    const dependencyOutputs = Object.fromEntries(node.dependsOn.map(id => [id, state.nodes[id].output ?? {}]));
    current.status = 'running'; current.startedAt = new Date(this.now()).toISOString();
    this.emit?.({ type: 'node.started', nodeId: node.id });
    while (current.attempts < policy.maxAttempts) {
      current.attempts++;
      const timeout = AbortSignal.timeout(policy.timeoutMs), combined = AbortSignal.any([signal, timeout]);
      try {
        const output = await policy.execute({ plan, node, dependencyOutputs }, combined);
        if (!plainRecord(output) || !jsonValue(output) || jsonBytes(output) > MAX_OUTPUT_BYTES) throw new Error('TASK_OUTPUT_INVALID');
        current.output = structuredClone(output) as Record<string, JsonValue>; current.status = 'succeeded';
        current.completedAt = new Date(this.now()).toISOString(); delete current.error;
        this.emit?.({ type: 'node.completed', nodeId: node.id }); return;
      } catch {
        if (policy.risk === 'write') {
          current.status = 'failed'; current.error = 'WRITE_RESULT_UNKNOWN'; current.completedAt = new Date(this.now()).toISOString();
          this.emit?.({ type: 'node.failed', nodeId: node.id, code: current.error }); return;
        }
        if (signal.aborted) { current.status = 'pending'; return; }
        if (current.attempts >= policy.maxAttempts) {
          current.status = 'failed'; current.error = timeout.aborted ? 'TOOL_TIMEOUT' : 'TOOL_FAILED';
          current.completedAt = new Date(this.now()).toISOString(); this.emit?.({ type: 'node.failed', nodeId: node.id, code: current.error }); return;
        }
      }
    }
  }

  private assertState(plan: TaskPlan, state: TaskState) {
    if (state.planId !== plan.id || state.planVersion !== plan.version
      || Object.keys(state.nodes).length !== plan.nodes.length || plan.nodes.some(node => !state.nodes[node.id])) throw new Error('TASK_STATE_MISMATCH');
  }
  private authorizationPayload(value: Omit<TaskAuthorization, 'proof'>) {
    return `${value.planId}\n${value.planVersion}\n${value.nodeId}\n${value.previewFingerprint}\n${value.expiresAt}`;
  }
  private signAuthorization(value: Omit<TaskAuthorization, 'proof'>) {
    return createHmac('sha256', this.authorizationKey).update(this.authorizationPayload(value)).digest('hex');
  }
  private validAuthorization(value: TaskAuthorization) {
    if (!/^[a-f0-9]{64}$/.test(value.proof)) return false;
    const expected = Buffer.from(this.signAuthorization(value), 'hex'), actual = Buffer.from(value.proof, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  private touch(state: TaskState) { state.updatedAt = new Date(this.now()).toISOString(); }
}

export function newTaskId() { return `task-${randomUUID()}`; }
