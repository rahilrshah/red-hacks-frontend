import { env } from '$env/dynamic/private';
import { PUBLIC_MAX_UPLOAD_MB, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { calculateAttackBonus, type AttackBonusResult } from '$lib/bonus';
import {
  buildJudgeUserMessage,
  DEFAULT_JUDGE_MODEL,
  DEFAULT_JUDGE_TEMPERATURE,
  JUDGE_SYSTEM_PROMPT,
  parseJudgeResponse,
  TIER_COEFFICIENTS,
  type JudgeRubric,
  type JudgeVerdict
} from '$lib/judge';
import { json, type RequestHandler } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';

const ATTACK_COOLDOWN_MS = 2 * 60 * 1000;

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

type RoundRow = {
  game_id: string;
  round_index: number;
  type: 'pvp' | 'pve' | string;
  required_defenses: number | null;
  available_challenges: string[] | null;
  duration_minutes: number | null;
  intermission_minutes: number | null;
  name?: string | null;
};

type AttackRequestBody = {
  defended_challenge_id?: string;
  challenge_id?: string;
  game_id?: string;
  prompt?: string;
  guess?: string;
  messages?: Array<{ role?: string; content?: string }>;
  attachments?: Array<{
    name?: string;
    type?: string;
    size?: number;
    content?: string;
  }>;
  challenge?: unknown;
  // judge-type challenges: set true on the End Attack click to trigger
  // the judge LLM evaluation over the full transcript.
  end_attack?: boolean;
};

type AttachmentSummary = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  content: string;
};

const DEFAULT_MAX_UPLOAD_MB = 10;
const ATTACHMENT_CONTEXT_CHAR_LIMIT = 12000;

function createSupabaseAdminClient() {
  const supabaseUrl = PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || env.PRIVATE_SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase admin credentials are not configured on the server.');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  const bearerMatch = authorizationHeader?.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1]?.trim() || null;
}

function normalizeMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter((message) => message && typeof message === 'object')
    .map((message: any) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : ''
    }))
    .filter((message) => ['system', 'user', 'assistant', 'tool'].includes(message.role) && message.content.length > 0);
}

function parseNumericEnv(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.trunc(parsed);
}

function getMaxUploadBytes() {
  const configuredMb = parseNumericEnv(env.MAX_UPLOAD_MB || PUBLIC_MAX_UPLOAD_MB, DEFAULT_MAX_UPLOAD_MB);
  return configuredMb * 1024 * 1024;
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeAttachmentSummaries(attachments: unknown): AttachmentSummary[] {
  if (!Array.isArray(attachments)) return [];

  return attachments
    .filter((attachment) => attachment && typeof attachment === 'object')
    .map((attachment: any) => ({
      name: typeof attachment.name === 'string' && attachment.name.trim().length > 0 ? attachment.name.trim() : 'attachment',
      mimeType: typeof attachment.type === 'string' && attachment.type.trim().length > 0 ? attachment.type.trim() : 'application/octet-stream',
      sizeBytes: Number.isFinite(Number(attachment.size)) ? Math.max(0, Math.trunc(Number(attachment.size))) : 0,
      content: typeof attachment.content === 'string' ? attachment.content : ''
    }))
    .filter((attachment) => attachment.content.length > 0 || attachment.sizeBytes > 0);
}

function buildAttachmentContext(attachments: AttachmentSummary[]): string {
  if (attachments.length === 0) {
    return '';
  }

  const parts = attachments.map((attachment) => {
    const trimmedContent = attachment.content.slice(0, ATTACHMENT_CONTEXT_CHAR_LIMIT);
    const contentBlock = trimmedContent.length > 0 ? `\n${trimmedContent}` : '';
    const truncatedSuffix = attachment.content.length > trimmedContent.length ? '\n[Attachment content truncated]' : '';
    return `[Attachment: ${attachment.name} | ${attachment.mimeType} | ${attachment.sizeBytes} bytes]${contentBlock}${truncatedSuffix}`;
  });

  return `Uploaded attachments:\n${parts.join('\n\n')}`;
}

function mergePromptWithAttachments(prompt: string, attachments: AttachmentSummary[]): string {
  const attachmentContext = buildAttachmentContext(attachments);
  return [prompt.trim(), attachmentContext].filter((part) => part.length > 0).join('\n\n');
}

async function parseAttackRequestBody(request: Request): Promise<AttackRequestBody> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const getString = (key: string) => {
      const value = formData.get(key);
      return typeof value === 'string' ? value : '';
    };

    const attachments: AttachmentSummary[] = [];
    const attachmentEntries = formData.getAll('attachments');
    const maxUploadBytes = getMaxUploadBytes();
    let totalBytes = 0;

    for (const entry of attachmentEntries) {
      if (!(entry instanceof File)) continue;
      totalBytes += entry.size;

      if (entry.size > maxUploadBytes || totalBytes > maxUploadBytes) {
        throw new Error(`Attached files exceed the ${parseNumericEnv(env.MAX_UPLOAD_MB || PUBLIC_MAX_UPLOAD_MB, DEFAULT_MAX_UPLOAD_MB)} MB limit.`);
      }

      const content = await entry.text();
      attachments.push({
        name: entry.name || 'attachment',
        mimeType: entry.type || 'application/octet-stream',
        sizeBytes: entry.size,
        content: content.slice(0, ATTACHMENT_CONTEXT_CHAR_LIMIT)
      });
    }

    return {
      defended_challenge_id: getString('defended_challenge_id') || undefined,
      challenge_id: getString('challenge_id') || undefined,
      game_id: getString('game_id') || undefined,
      prompt: getString('prompt') || undefined,
      guess: getString('guess') || undefined,
      messages: safeJsonParse(getString('messages'), [] as Array<{ role?: string; content?: string }>),
      challenge: safeJsonParse(getString('challenge'), null),
      attachments
    };
  }

  return (await request.json()) as AttackRequestBody;
}

function asValidDateMs(value: string | null | undefined): number | null {
  if (!value) return null;

  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return null;

  return ms;
}

/**
 * Call the judge LLM via OpenRouter to evaluate a judge-type challenge
 * attack transcript. Returns a parsed verdict or {ok:false} on any
 * failure (API, parse, validation). Callers treat !ok as escalate.
 */
async function callJudgeLlm(args: {
  rubric: JudgeRubric | null | undefined;
  defenderSystemPrompt: string | null | undefined;
  transcript: Array<{ role: string; content: string }>;
  challengeModel?: string | null;
}): Promise<
  | { ok: true; verdict: JudgeVerdict; coefficient: number | null; reason: string; model: string }
  | { ok: false; reason: string }
> {
  const openRouterKey = env.OPENROUTER_KEY?.trim();
  if (!openRouterKey) {
    return { ok: false, reason: 'OPENROUTER_KEY missing; judge cannot run' };
  }

  const model = (args.challengeModel && args.challengeModel.trim()) || env.JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
  const temperatureRaw = Number(env.JUDGE_TEMPERATURE);
  const temperature = Number.isFinite(temperatureRaw) ? temperatureRaw : DEFAULT_JUDGE_TEMPERATURE;

  const userMessage = buildJudgeUserMessage({
    rubric: args.rubric,
    defenderSystemPrompt: args.defenderSystemPrompt,
    transcript: args.transcript
  });

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openRouterKey}`
      },
      body: JSON.stringify({
        model,
        temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: userMessage }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { ok: false, reason: `judge API ${response.status}: ${errText.slice(0, 200)}` };
    }

    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return { ok: false, reason: 'judge response had no content' };
    }

    const parsed = parseJudgeResponse(content);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }

    return { ok: true, verdict: parsed.verdict, coefficient: parsed.coefficient, reason: parsed.reason, model };
  } catch (err: any) {
    return { ok: false, reason: err?.message || 'judge fetch threw' };
  }
}

function normalizeMinutes(value: number | null | undefined, minimum: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return minimum;
  return Math.max(minimum, Math.trunc(value));
}

function resolveActiveRound(gameStartIso: string, rounds: RoundRow[], nowMs: number): RoundRow | null {
  const gameStartMs = asValidDateMs(gameStartIso);
  if (gameStartMs === null) return null;

  const orderedRounds = [...rounds].sort((a, b) => a.round_index - b.round_index);
  let cursorMs = gameStartMs;

  for (const round of orderedRounds) {
    const durationMs = normalizeMinutes(round.duration_minutes, 1) * 60_000;
    const intermissionMs = normalizeMinutes(round.intermission_minutes, 0) * 60_000;
    const roundStartMs = cursorMs;
    const roundEndMs = roundStartMs + durationMs;

    if (nowMs >= roundStartMs && nowMs < roundEndMs) {
      return round;
    }

    cursorMs = roundEndMs + intermissionMs;
  }

  return null;
}

function parseChallengeObjective(challenge: any): string {
  if (challenge?.type === 'tool-calling') {
    return `Induce targeted tool use: ${challenge?.target_tool_name ?? 'unknown tool'}`;
  }

  return 'Extract the secret key.';
}

function resolveChallengeTools(challenge: any) {
  const rows = Array.isArray(challenge?.challenge_tools) ? challenge.challenge_tools : [];

  return rows
    .map((row: any) => row?.tools)
    .filter((tool: any) => !!tool);
}

function buildResolvedChallengePayload(targetDetails: any, challengeId: string, targetSecretKey: string | null) {
  const challenges = targetDetails?.challenges ?? {};
  const challengeSystemPrompt =
    (challenges?.default_prompt as string | undefined)?.trim() ||
    (challenges?.context as string | undefined)?.trim() ||
    'You are a helpful assistant.';
  const defenderSystemPrompt = (targetDetails?.system_prompt as string | undefined)?.trim() || null;

  return {
    challenge_id: challengeId,
    challenge_type: challenges?.type ?? null,
    title: challenges?.model_name ?? 'Challenge',
    description: challenges?.description ?? '',
    objective: parseChallengeObjective(challenges),
    challenge_system_prompt: challengeSystemPrompt,
    defender_system_prompt: defenderSystemPrompt,
    system_prompt: defenderSystemPrompt || challengeSystemPrompt,
    success_tool_name: challenges?.target_tool_name ?? null,
    success_tool_args: challenges?.target_tool_args ?? null,
    interp_args: challenges?.interp_args ?? null,
    tools: resolveChallengeTools(challenges),
    target_secret_key: targetSecretKey
  };
}

async function parseResponseBody(response: Response) {
  const responseText = await response.text();

  try {
    return responseText ? JSON.parse(responseText) : null;
  } catch {
    return responseText;
  }
}

function buildAttackRequestPayload(body: AttackRequestBody, targetDetails: any, challengeId: string, targetSecretKey: string | null) {
  const attachmentSummaries = normalizeAttachmentSummaries(body.attachments);
  const mergedPrompt = mergePromptWithAttachments(body.prompt?.trim() || normalizeMessages(body.messages).at(-1)?.content || '', attachmentSummaries);
  const normalizedMessages = normalizeMessages(body.messages);
  const messagesWithAttachments = normalizedMessages.length > 0
    ? [...normalizedMessages.slice(0, -1), { ...normalizedMessages.at(-1)!, content: mergedPrompt }]
    : (mergedPrompt ? [{ role: 'user', content: mergedPrompt }] : []);

  const payload: Record<string, unknown> = {
    prompt: mergedPrompt,
    guess: body.guess?.trim() || '',
    messages: messagesWithAttachments,
    attachments: attachmentSummaries.map((attachment) => ({
      name: attachment.name,
      type: attachment.mimeType,
      size: attachment.sizeBytes,
      content: attachment.content
    })),
    challenge: buildResolvedChallengePayload(targetDetails, challengeId, targetSecretKey)
  };

  if (targetDetails?.challenge_mode === 'pve') {
    payload.challenge_id = challengeId;
    payload.game_id = targetDetails?.game_id;
    payload.round_type = 'pve';
  } else {
    payload.defended_challenge_id = targetDetails?.id ?? challengeId;
  }

  return payload;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

async function forwardToBackend(url: string, requestInit: RequestInit) {
  const response = await fetch(url, requestInit);
  const parsedBody = await parseResponseBody(response);

  return { response, parsedBody };
}

async function applyCoinSteal(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  attackerTeamId: string,
  defenderTeamId: string,
  challengeId: string
) {
  const { data, error } = await supabaseAdmin.rpc('transfer_attack_coins', {
    p_attacker_team_id: attackerTeamId,
    p_defender_team_id: defenderTeamId,
    p_challenge_id: challengeId
  });

  if (error) {
    throw new Error(error.message || 'Failed to transfer attack coins');
  }

  const row = Array.isArray(data) ? data[0] : data;

  if (!row) {
    throw new Error('No transfer result returned');
  }

  return row;
}

async function incrementTeamCoins(
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>,
  teamId: string,
  delta: number
) {
  const { data, error } = await supabaseAdmin.rpc('increment_team_coins', {
    p_team_id: teamId,
    p_delta: delta
  });

  if (error) {
    throw new Error(error.message || 'Failed to increment team coins');
  }

  if (typeof data === 'number') {
    return data;
  }

  if (Array.isArray(data) && typeof data[0] === 'number') {
    return data[0];
  }

  return null;
}

type EleganceBonusArgs = {
  supabaseAdmin: ReturnType<typeof createSupabaseAdminClient>;
  attackerTeamId: string;
  defendedChallengeId: string | null;
  pveChallengeId: string | null;
  defendedChallengeUpdatedAt: string | null;
  attackStealCoins: number;
  defenseRewardCoins: number;
  currentPromptChars: number;
};

type EleganceBonusOutcome = AttackBonusResult & { turnCount: number; charCount: number };

async function computeEleganceBonus(args: EleganceBonusArgs): Promise<EleganceBonusOutcome> {
  const targetFilter = args.defendedChallengeId
    ? { column: 'defended_challenge_id', value: args.defendedChallengeId }
    : { column: 'challenge_id', value: args.pveChallengeId ?? '' };

  const { data: lastSuccess } = await args.supabaseAdmin
    .from('attacks')
    .select('created_at')
    .eq('attacker_team_id', args.attackerTeamId)
    .eq(targetFilter.column, targetFilter.value)
    .eq('is_successful', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastSuccessMs = lastSuccess?.created_at ? new Date(lastSuccess.created_at).getTime() : 0;
  const updatedAtMs = args.defendedChallengeUpdatedAt
    ? new Date(args.defendedChallengeUpdatedAt).getTime()
    : 0;
  const windowStartMs = Math.max(lastSuccessMs, updatedAtMs);
  const windowStartIso = new Date(windowStartMs).toISOString();

  const { data: priorAttempts } = await args.supabaseAdmin
    .from('attacks')
    .select('is_successful, log')
    .eq('attacker_team_id', args.attackerTeamId)
    .eq(targetFilter.column, targetFilter.value)
    .gt('created_at', windowStartIso)
    .eq('is_successful', false);

  const priorTurns = priorAttempts?.length ?? 0;
  const priorChars = (priorAttempts ?? []).reduce((acc, row: any) => {
    const logPrompt = row?.log?.latest_prompt;
    return acc + (typeof logPrompt === 'string' ? logPrompt.length : 0);
  }, 0);

  const turnCount = priorTurns + 1;
  const charCount = priorChars + Math.max(0, args.currentPromptChars);

  const bonus = calculateAttackBonus({
    turnCount,
    charCount,
    attackStealCoins: args.attackStealCoins,
    defenseRewardCoins: args.defenseRewardCoins
  });

  return { ...bonus, turnCount, charCount };
}

export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const supabaseAdmin = createSupabaseAdminClient();
    const supabaseUrl = PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = env.PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;

    if (!supabaseUrl) {
      return json({ success: false, error: 'Supabase URL is not configured on the server.' }, { status: 500 });
    }

    const accessToken = extractBearerToken(request.headers.get('authorization'));
    if (!accessToken) {
      return json({ success: false, error: 'Unauthorized: valid JWT required' }, { status: 401 });
    }

    const { data: authData } = await supabaseAdmin.auth.getUser(accessToken);
    const attackerUserId = authData.user?.id ?? null;

    if (!attackerUserId) {
      return json({ success: false, error: 'Unauthorized: valid JWT required' }, { status: 401 });
    }

    const body = await parseAttackRequestBody(request);
    const gameId = params.gameId;
    const requestedGameId = typeof body.game_id === 'string' && body.game_id.trim().length > 0 ? body.game_id.trim() : gameId;

    if (!requestedGameId || requestedGameId !== gameId) {
      return json({ success: false, error: 'game_id does not match the requested route.' }, { status: 400 });
    }

    const defendedChallengeId = typeof body.defended_challenge_id === 'string' && body.defended_challenge_id.trim().length > 0 ? body.defended_challenge_id.trim() : null;
    const challengeId = typeof body.challenge_id === 'string' && body.challenge_id.trim().length > 0 ? body.challenge_id.trim() : null;

    if (!defendedChallengeId && !challengeId) {
      return json({ success: false, error: 'defended_challenge_id or challenge_id is required' }, { status: 400 });
    }

    const { data: gameWindow, error: gameWindowError } = await supabaseAdmin
      .from('games')
      .select('id, is_active, start_time, end_time')
      .eq('id', gameId)
      .maybeSingle();

    if (gameWindowError || !gameWindow) {
      return json({ success: false, error: 'Could not load game timing configuration' }, { status: 500 });
    }

    const nowMs = Date.now();
    const gameStartMs = asValidDateMs(gameWindow.start_time);
    const gameEndMs = asValidDateMs(gameWindow.end_time);

    if (!gameWindow.is_active || gameStartMs === null || gameEndMs === null || nowMs < gameStartMs || nowMs > gameEndMs) {
      return json({ success: false, error: 'This game is not currently active' }, { status: 403 });
    }

    const { data: roundRows, error: roundRowsError } = await supabaseAdmin
      .from('rounds')
      .select('game_id, round_index, type, required_defenses, available_challenges, duration_minutes, intermission_minutes, name')
      .eq('game_id', gameId)
      .order('round_index', { ascending: true });

    if (roundRowsError) {
      return json({ success: false, error: 'Could not load round configuration' }, { status: 500 });
    }

    const activeRound = resolveActiveRound(gameWindow.start_time, (roundRows ?? []) as RoundRow[], nowMs);
    if (!activeRound) {
      return json({ success: false, error: 'There is no active round to attack right now' }, { status: 403 });
    }

    const activeRoundChallengeIds = (activeRound.available_challenges ?? []).filter((roundChallengeId): roundChallengeId is string => typeof roundChallengeId === 'string' && roundChallengeId.length > 0);
    const isPveTarget = activeRound.type === 'pve';

    let targetDetails: any = null;
    let targetSecretKey: string | null = null;
    let effectiveChallengeId: string | null = null;
    let attackerTeamId: string | null = null;

    if (isPveTarget) {
      if (!challengeId) {
        return json({ success: false, error: 'challenge_id is required for pve attacks' }, { status: 400 });
      }

      const { data: challengeData, error: challengeError } = await supabaseAdmin
        .from('challenges')
        .select('*, interp_args(*), challenge_tools(tools(*))')
        .eq('id', challengeId)
        .single();

      if (challengeError || !challengeData) {
        return json({ success: false, error: 'Challenge not found' }, { status: 404 });
      }

      if (!activeRoundChallengeIds.includes(challengeData.id)) {
        return json({ success: false, error: 'This challenge is not enabled in the active round' }, { status: 403 });
      }

      const { data: gameChallengeRow, error: gameChallengeError } = await supabaseAdmin
        .from('game_challenges')
        .select('challenge_id')
        .eq('game_id', gameId)
        .eq('challenge_id', challengeData.id)
        .maybeSingle();

      if (gameChallengeError || !gameChallengeRow) {
        return json({ success: false, error: 'This challenge is not enabled for the game' }, { status: 403 });
      }

      const { data: gameMembership } = await supabaseAdmin
        .from('team_members')
        .select('team_id, teams!inner(game_id)')
        .eq('user_id', attackerUserId)
        .eq('teams.game_id', gameId)
        .limit(1)
        .maybeSingle();

      attackerTeamId = gameMembership?.team_id ?? null;

      if (!attackerTeamId) {
        return json({ success: false, error: 'Attacker is not part of this game' }, { status: 403 });
      }

      targetDetails = {
        id: challengeData.id,
        team_id: null,
        challenge_id: challengeData.id,
        game_id: gameId,
        challenge_mode: 'pve',
        system_prompt: challengeData.default_prompt?.trim() || challengeData.context?.trim() || 'You are a helpful assistant.',
        teams: {
          name: activeRound.name ?? 'Default Defense',
          game_id: gameId,
          coins: 0
        },
        challenges: challengeData
      };

      effectiveChallengeId = challengeData.id;
    } else {
      if (!defendedChallengeId) {
        return json({ success: false, error: 'defended_challenge_id is required for pvp attacks' }, { status: 400 });
      }

      const { data: defendedTarget, error: targetError } = await supabaseAdmin
        .from('defended_challenges')
        .select('*, challenges(*, interp_args(*), challenge_tools(tools(*))), teams(name, game_id, coins)')
        .eq('id', defendedChallengeId)
        .single();

      if (targetError || !defendedTarget) {
        return json({ success: false, error: 'Target not found' }, { status: 404 });
      }

      effectiveChallengeId = defendedTarget.challenge_id;
      targetSecretKey = typeof defendedTarget.target_secret_key === 'string' ? defendedTarget.target_secret_key : null;

      if (!defendedTarget.teams?.game_id) {
        return json({ success: false, error: 'Target is not tied to a valid game' }, { status: 400 });
      }

      if (!activeRoundChallengeIds.includes(defendedTarget.challenge_id)) {
        return json({ success: false, error: 'This challenge is not enabled in the active round' }, { status: 403 });
      }

      const { data: allowedGameChallenge, error: allowedGameChallengeError } = await supabaseAdmin
        .from('game_challenges')
        .select('challenge_id')
        .eq('game_id', gameId)
        .eq('challenge_id', defendedTarget.challenge_id)
        .maybeSingle();

      if (allowedGameChallengeError || !allowedGameChallenge) {
        return json({ success: false, error: 'This challenge is not enabled for the game' }, { status: 403 });
      }

      const { data: gameMembership } = await supabaseAdmin
        .from('team_members')
        .select('team_id, teams!inner(game_id)')
        .eq('user_id', attackerUserId)
        .eq('teams.game_id', gameId)
        .limit(1)
        .maybeSingle();

      attackerTeamId = gameMembership?.team_id ?? null;

      if (!attackerTeamId) {
        return json({ success: false, error: 'Attacker is not part of this game' }, { status: 403 });
      }

      const requiredDefenses = Math.max(0, Math.trunc(activeRound.required_defenses ?? 0));
      if (requiredDefenses > 0) {
        const { count: defendedCount, error: defendedCountError } = await supabaseAdmin
          .from('defended_challenges')
          .select('id', { count: 'exact', head: true })
          .eq('team_id', attackerTeamId)
          .eq('is_active', true)
          .in('challenge_id', activeRoundChallengeIds);

        if (defendedCountError) {
          return json({ success: false, error: 'Could not verify defended prompts requirement' }, { status: 500 });
        }

        if ((defendedCount ?? 0) < requiredDefenses) {
          return json(
            {
              success: false,
              error: `Attack blocked. Defend at least ${requiredDefenses} prompt(s) for this round before attacking.`,
              required_defenses: requiredDefenses,
              defended_count: defendedCount ?? 0
            },
            { status: 403 }
          );
        }
      }

      if (attackerTeamId === defendedTarget.team_id) {
        return json({ success: false, error: 'You cannot attack your own team defense' }, { status: 400 });
      }

      // Block re-attacks once this attacker team has already fully compromised
      // this specific defense. Non-judge challenges: any is_successful=true row
      // counts. Judge challenges: only a 'full' verdict (coefficient=1) counts —
      // partial compromises are not final, so the attacker can keep trying.
      const { data: priorCompromises } = await supabaseAdmin
        .from('attacks')
        .select('id, judge_verdict, is_successful')
        .eq('attacker_team_id', attackerTeamId)
        .eq('defended_challenge_id', defendedChallengeId);

      const alreadyCompromised = (priorCompromises ?? []).some((row: any) => {
        if (row.judge_verdict) return row.judge_verdict === 'full';
        return row.is_successful === true;
      });

      if (alreadyCompromised) {
        return json(
          {
            success: false,
            already_compromised: true,
            error: 'You have already compromised this defense. You cannot attack it again.'
          },
          { status: 403 }
        );
      }

      if ((defendedTarget.teams?.coins ?? 0) <= 0) {
        return json(
          {
            success: false,
            message: 'Target team is already eliminated (0 coins).',
            log: 'Attack blocked because defender has no coins remaining.'
          },
          { status: 200 }
        );
      }

      targetDetails = defendedTarget;
    }

    if (!effectiveChallengeId) {
      return json({ success: false, error: 'Could not resolve the challenge for this attack.' }, { status: 500 });
    }

    // ---------- End Attack: judge-evaluated challenges ----------
    // For judge-type challenges, individual prompts are forwarded normally
    // (no per-turn success check / coin transfer). On End Attack the judge
    // LLM evaluates the full transcript and we settle (or escrow) once.
    const challengeType = targetDetails?.challenges?.type as string | undefined;
    const isJudgeChallenge = challengeType === 'judge';

    if (body.end_attack === true) {
      if (!isJudgeChallenge) {
        return json({ success: false, error: 'End Attack is only supported on judge-type challenges.' }, { status: 400 });
      }

      if (isPveTarget) {
        return json({ success: false, error: 'Judge challenges in PvE mode are not yet supported.' }, { status: 400 });
      }

      if (!attackerTeamId || !targetDetails?.team_id) {
        return json({ success: false, error: 'Missing team context for judge settlement.' }, { status: 400 });
      }

      const rubric = (targetDetails?.challenges?.judge_rubric ?? null) as JudgeRubric | null;
      const judgeModel = typeof targetDetails?.challenges?.judge_model === 'string' ? targetDetails.challenges.judge_model : null;
      const defenderSystemPrompt = typeof targetDetails?.system_prompt === 'string' ? targetDetails.system_prompt : null;
      const transcript = normalizeMessages(body.messages).map((m) => ({ role: m.role, content: m.content }));

      const judgeResult = await callJudgeLlm({
        rubric,
        defenderSystemPrompt,
        transcript,
        challengeModel: judgeModel
      });

      // Snapshot the inputs used for bonus calc so admin review is deterministic.
      const challengeStealCoins = Math.max(0, Math.trunc(targetDetails?.challenges?.attack_steal_coins ?? 0));
      const challengeDefenseReward = Math.max(0, Math.trunc(targetDetails?.challenges?.defense_reward_coins ?? 0));

      // Count all per-turn attempts this team has logged against this target
      // since the last successful attack / defender prompt update / now. This
      // is the server-authoritative turn count — it includes turns the user
      // cleared on the client via Clear Chat, so clearing doesn't game the bonus.
      const { data: lastSuccess } = await supabaseAdmin
        .from('attacks')
        .select('created_at')
        .eq('attacker_team_id', attackerTeamId)
        .eq('defended_challenge_id', targetDetails.id)
        .eq('is_successful', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const lastSuccessMs = lastSuccess?.created_at ? new Date(lastSuccess.created_at).getTime() : 0;
      const updatedAtMs = targetDetails?.updated_at ? new Date(targetDetails.updated_at).getTime() : 0;
      const windowStartIso = new Date(Math.max(lastSuccessMs, updatedAtMs)).toISOString();

      const { data: priorTurns } = await supabaseAdmin
        .from('attacks')
        .select('log')
        .eq('attacker_team_id', attackerTeamId)
        .eq('defended_challenge_id', targetDetails.id)
        .eq('is_successful', false)
        .gt('created_at', windowStartIso);

      // Fall back to client transcript if the server count is somehow empty
      // (shouldn't happen now that per-turn prompts log, but defensive).
      const clientTurnCount = transcript.filter((m) => m.role === 'user').length;
      const clientCharCount = transcript.filter((m) => m.role === 'user').reduce((acc, m) => acc + m.content.length, 0);

      const serverTurnCount = priorTurns?.length ?? 0;
      const serverCharCount = (priorTurns ?? []).reduce((acc, row: any) => {
        const p = row?.log?.latest_prompt;
        return acc + (typeof p === 'string' ? p.length : 0);
      }, 0);

      const userTurnCount = Math.max(serverTurnCount, clientTurnCount);
      const userCharCount = Math.max(serverCharCount, clientCharCount);

      const escrowSnapshot = {
        attack_steal_coins: challengeStealCoins,
        defense_reward_coins: challengeDefenseReward,
        turn_count: userTurnCount,
        char_count: userCharCount
      };

      const maxPotential = calculateAttackBonus({
        turnCount: userTurnCount,
        charCount: userCharCount,
        attackStealCoins: challengeStealCoins,
        defenseRewardCoins: challengeDefenseReward,
        coefficient: 1
      });

      // Escalate path (judge failed or explicitly escalated): hold escrow from defender, no payout yet.
      if (!judgeResult.ok || judgeResult.verdict === 'escalate') {
        const escalateReason = judgeResult.ok ? judgeResult.reason : judgeResult.reason;
        const heldAmount = Math.min(targetDetails.teams?.coins ?? 0, maxPotential.total);

        let defenderCoinsAfter: number | null = targetDetails.teams?.coins ?? null;
        let defenderEliminated = false;
        if (heldAmount > 0) {
          const newDefenderBalance = await incrementTeamCoins(supabaseAdmin, targetDetails.team_id, -heldAmount);
          if (typeof newDefenderBalance === 'number') defenderCoinsAfter = newDefenderBalance;
          if (typeof newDefenderBalance === 'number' && newDefenderBalance <= 0) {
            defenderEliminated = true;
            await supabaseAdmin
              .from('defended_challenges')
              .update({ is_active: false })
              .eq('team_id', targetDetails.team_id);
          }
        }

        const attackLog = {
          source: 'judge',
          outcome: 'escalated',
          latest_prompt: '(end attack)',
          escalation_reason: escalateReason,
          escrow_amount: heldAmount,
          escrow_snapshot: escrowSnapshot,
          max_potential_total: maxPotential.total,
          transcript_length: transcript.length,
          defender_coins_after: defenderCoinsAfter,
          defender_eliminated: defenderEliminated
        };

        const { data: inserted } = await supabaseAdmin
          .from('attacks')
          .insert({
            defended_challenge_id: targetDetails?.id ?? defendedChallengeId,
            challenge_id: effectiveChallengeId,
            attacker_user_id: attackerUserId,
            attacker_team_id: attackerTeamId,
            is_successful: false, // coins haven't moved to attacker yet
            log: attackLog,
            judge_verdict: 'escalate',
            judge_coefficient: null,
            judge_reason: escalateReason,
            escalation_status: 'pending',
            escrow_amount: heldAmount,
            escrow_snapshot: escrowSnapshot
          })
          .select('id')
          .single();

        return json({
          success: false,
          attack_id: inserted?.id ?? null,
          escalated: true,
          message: 'Attack submitted for admin review. Coins held in escrow pending decision.',
          escrow_amount: heldAmount,
          max_potential_total: maxPotential.total,
          judge_reason: escalateReason
        });
      }

      // Real verdict: settle immediately.
      const coefficient = TIER_COEFFICIENTS[judgeResult.verdict];
      const reward = calculateAttackBonus({
        turnCount: userTurnCount,
        charCount: userCharCount,
        attackStealCoins: challengeStealCoins,
        defenseRewardCoins: challengeDefenseReward,
        coefficient
      });

      let defenderCoinsAfter: number | null = targetDetails.teams?.coins ?? null;
      let attackerCoinsAfter: number | null = null;
      let defenderEliminated = false;
      const totalTransfer = Math.min(targetDetails.teams?.coins ?? 0, reward.total);

      if (totalTransfer > 0) {
        // Zero-sum: subtract from defender, add to attacker.
        const newDefenderBalance = await incrementTeamCoins(supabaseAdmin, targetDetails.team_id, -totalTransfer);
        if (typeof newDefenderBalance === 'number') defenderCoinsAfter = newDefenderBalance;
        if (typeof newDefenderBalance === 'number' && newDefenderBalance <= 0) {
          defenderEliminated = true;
          await supabaseAdmin
            .from('defended_challenges')
            .update({ is_active: false })
            .eq('team_id', targetDetails.team_id);
        }

        const newAttackerBalance = await incrementTeamCoins(supabaseAdmin, attackerTeamId, totalTransfer);
        if (typeof newAttackerBalance === 'number') attackerCoinsAfter = newAttackerBalance;
      }

      const attackLog = {
        source: 'judge',
        outcome: judgeResult.verdict,
        latest_prompt: '(end attack)',
        judge_reason: judgeResult.reason,
        judge_model: judgeResult.model,
        base_coins: reward.base,
        bonus_coins: reward.bonus,
        stolen_coins: totalTransfer,
        elegance_factor: reward.eleganceFactor,
        max_bonus: reward.maxBonus,
        coefficient,
        turn_count: userTurnCount,
        char_count: userCharCount,
        defender_coins_after: defenderCoinsAfter,
        attacker_coins_after: attackerCoinsAfter,
        defender_eliminated: defenderEliminated
      };

      // Every real verdict is a terminal "attempt concluded" event. Marking
      // is_successful=true advances the bonus window (see refreshServerTurnCount
      // and computeEleganceBonus) so the attacker's next attempt on this
      // defender starts fresh. 'none' gets this too — the attacker is entitled
      // to a clean slate after the judge rules, even without a payout. The
      // "already compromised" re-attack block keys off judge_verdict='full', so
      // flipping is_successful on non-full verdicts doesn't lock them out.
      const { data: insertedVerdictRow } = await supabaseAdmin
        .from('attacks')
        .insert({
          defended_challenge_id: targetDetails?.id ?? defendedChallengeId,
          challenge_id: effectiveChallengeId,
          attacker_user_id: attackerUserId,
          attacker_team_id: attackerTeamId,
          is_successful: true,
          log: attackLog,
          judge_verdict: judgeResult.verdict,
          judge_coefficient: coefficient,
          judge_reason: judgeResult.reason,
          escalation_status: null,
          escrow_amount: null,
          escrow_snapshot: escrowSnapshot
        })
        .select('id')
        .single();

      return json({
        success: coefficient > 0,
        attack_id: insertedVerdictRow?.id ?? null,
        verdict: judgeResult.verdict,
        coefficient,
        judge_reason: judgeResult.reason,
        stolen_coins: totalTransfer,
        base_coins: reward.base,
        bonus_coins: reward.bonus,
        elegance_factor: reward.eleganceFactor,
        max_bonus: reward.maxBonus,
        turn_count: userTurnCount,
        char_count: userCharCount,
        defender_coins_after: defenderCoinsAfter,
        attacker_coins_after: attackerCoinsAfter,
        defender_eliminated: defenderEliminated
      });
    }

    const outboundPayload = buildAttackRequestPayload(body, targetDetails, effectiveChallengeId, targetSecretKey);
    const hasDirectBackend = typeof targetDetails?.challenges?.challenge_url === 'string' && targetDetails.challenges.challenge_url.trim().length > 0;

    const outboundHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (!hasDirectBackend) {
      outboundHeaders.Authorization = `Bearer ${accessToken}`;

      if (supabaseAnonKey) {
        outboundHeaders.apikey = supabaseAnonKey;
      }
    }

    // Judge challenges with no explicit challenge_url: route per-turn
    // prompts to OpenRouter directly from this Node process. Avoids a
    // known DNS flake when the Deno-in-Docker edge function tries to
    // resolve external hostnames. End Attack already goes through
    // callJudgeLlm() above, which runs here too — so judge challenges
    // end up fully self-contained in this file.
    if (isJudgeChallenge && !hasDirectBackend) {
      const openRouterKey = env.OPENROUTER_KEY?.trim();
      if (!openRouterKey) {
        return json({
          success: false,
          judge_pending: true,
          message: 'OPENROUTER_KEY missing on the server; judge challenges cannot run.'
        });
      }

      const modelName = targetDetails?.challenges?.model_name || 'openai/gpt-4o-mini';
      const baseSystemPrompt = (targetDetails?.system_prompt as string | undefined)?.trim()
        || (targetDetails?.challenges?.default_prompt as string | undefined)?.trim()
        || 'You are a helpful assistant.';
      const chatMessages = normalizeMessages(body.messages);
      const systemMessage = { role: 'system' as const, content: baseSystemPrompt };

      try {
        const openRouterResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openRouterKey}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: [systemMessage, ...chatMessages.map((m) => ({ role: m.role, content: m.content }))]
          })
        });

        if (!openRouterResponse.ok) {
          const errText = await openRouterResponse.text();
          return json({
            success: false,
            judge_pending: true,
            message: `OpenRouter ${openRouterResponse.status}: ${errText.slice(0, 300)}`
          });
        }

        const openRouterBody = await openRouterResponse.json();
        const assistantContent = openRouterBody?.choices?.[0]?.message?.content ?? '';

        // Log the per-turn attempt so the attacks table has the full history
        // for bonus calc. Without this, Clear Chat "resets" turn counts on the
        // server because there's no record of prior judge-type prompts.
        // The End Attack handler later queries these rows via computeEleganceBonus.
        if (attackerTeamId && targetDetails?.id) {
          const latestPrompt = body.prompt?.trim() || chatMessages.at(-1)?.content || '';
          await supabaseAdmin.from('attacks').insert({
            defended_challenge_id: targetDetails.id,
            challenge_id: effectiveChallengeId,
            attacker_user_id: attackerUserId,
            attacker_team_id: attackerTeamId,
            is_successful: false,
            log: {
              source: 'judge-per-turn',
              latest_prompt: latestPrompt,
              assistant_message: String(assistantContent),
              model_name: modelName
            }
          });
        }

        return json({
          success: false,
          judge_pending: true,
          message: 'Prompt evaluated by the model. Click End Attack when ready to submit to the judge.',
          assistant: String(assistantContent)
        });
      } catch (err: any) {
        return json({
          success: false,
          judge_pending: true,
          message: err?.message || 'Failed to reach OpenRouter.'
        });
      }
    }

    const targetUrl = hasDirectBackend
      ? targetDetails.challenges.challenge_url
      : `${supabaseUrl.replace(/\/$/, '')}/functions/v1/attack`;

    const { response, parsedBody } = await forwardToBackend(targetUrl, {
      method: 'POST',
      headers: outboundHeaders,
      body: JSON.stringify(outboundPayload),
      mode: 'cors'
    });

    // For judge-type challenges, per-turn responses from the backend are
    // forwarded as-is with no coin transfer — settlement happens only on
    // End Attack via the judge above. Skip the normal success/coin block.
    if (isJudgeChallenge) {
      // Force success:false so the frontend doesn't show "target compromised"
      // on individual turns. The chat UI still shows the model's reply.
      if (parsedBody && typeof parsedBody === 'object') {
        (parsedBody as any).success = false;
        (parsedBody as any).judge_pending = true;
      }
    } else if (hasDirectBackend && response.ok && parsedBody && typeof parsedBody === 'object' && (parsedBody as any).success === true) {
      const backendReportedTransfer =
        typeof (parsedBody as any).stolen_coins === 'number' ||
        typeof (parsedBody as any).attacker_coins_after === 'number' ||
        typeof (parsedBody as any).defender_coins_after === 'number';

      const currentPromptChars = (
        body.prompt?.trim() || normalizeMessages(body.messages).at(-1)?.content || ''
      ).length;
      const challengeStealCoins = Math.max(0, Math.trunc(targetDetails?.challenges?.attack_steal_coins ?? 0));
      const challengeDefenseReward = Math.max(0, Math.trunc(targetDetails?.challenges?.defense_reward_coins ?? 0));

      if (isPveTarget) {
        if (challengeStealCoins > 0 && attackerTeamId && effectiveChallengeId) {
          const bonusResult = await computeEleganceBonus({
            supabaseAdmin,
            attackerTeamId,
            defendedChallengeId: null,
            pveChallengeId: effectiveChallengeId,
            defendedChallengeUpdatedAt: null,
            attackStealCoins: challengeStealCoins,
            defenseRewardCoins: challengeDefenseReward,
            currentPromptChars
          });

          const totalReward = bonusResult.base + bonusResult.bonus;
          const attackerCoinsAfter = totalReward > 0
            ? await incrementTeamCoins(supabaseAdmin, attackerTeamId, totalReward)
            : null;

          (parsedBody as any).stolen_coins = totalReward;
          (parsedBody as any).base_coins = bonusResult.base;
          (parsedBody as any).bonus_coins = bonusResult.bonus;
          (parsedBody as any).elegance_factor = bonusResult.eleganceFactor;
          (parsedBody as any).max_bonus = bonusResult.maxBonus;
          (parsedBody as any).turn_count = bonusResult.turnCount;
          (parsedBody as any).char_count = bonusResult.charCount;
          (parsedBody as any).attacker_coins_after = attackerCoinsAfter;
        } else {
          (parsedBody as any).stolen_coins = 0;
          (parsedBody as any).base_coins = 0;
          (parsedBody as any).bonus_coins = 0;
        }
      } else if (!backendReportedTransfer && attackerTeamId && targetDetails?.team_id && effectiveChallengeId) {
        const transferResult = await applyCoinSteal(supabaseAdmin, attackerTeamId, targetDetails.team_id, effectiveChallengeId);

        if (transferResult.defender_eliminated) {
          await supabaseAdmin
            .from('defended_challenges')
            .update({ is_active: false })
            .eq('team_id', targetDetails.team_id);
        }

        const bonusResult = await computeEleganceBonus({
          supabaseAdmin,
          attackerTeamId,
          defendedChallengeId: targetDetails.id,
          pveChallengeId: null,
          defendedChallengeUpdatedAt: targetDetails?.updated_at ?? null,
          attackStealCoins: challengeStealCoins,
          defenseRewardCoins: challengeDefenseReward,
          currentPromptChars
        });

        let attackerCoinsAfter = transferResult.attacker_coins ?? null;
        if (bonusResult.bonus > 0) {
          const newBalance = await incrementTeamCoins(supabaseAdmin, attackerTeamId, bonusResult.bonus);
          if (typeof newBalance === 'number') attackerCoinsAfter = newBalance;
        }

        const baseCoins = transferResult.stolen_coins ?? 0;
        (parsedBody as any).stolen_coins = baseCoins + bonusResult.bonus;
        (parsedBody as any).base_coins = baseCoins;
        (parsedBody as any).bonus_coins = bonusResult.bonus;
        (parsedBody as any).elegance_factor = bonusResult.eleganceFactor;
        (parsedBody as any).max_bonus = bonusResult.maxBonus;
        (parsedBody as any).turn_count = bonusResult.turnCount;
        (parsedBody as any).char_count = bonusResult.charCount;
        (parsedBody as any).defender_coins_after = transferResult.defender_coins ?? null;
        (parsedBody as any).attacker_coins_after = attackerCoinsAfter;
        (parsedBody as any).defender_eliminated = transferResult.defender_eliminated ?? false;
      }
    }

    if (hasDirectBackend) {
      const parsedObject = parsedBody && typeof parsedBody === 'object' ? (parsedBody as any) : null;
      const attackSucceeded = response.ok && (parsedObject?.success === true || parsedObject?.success === 'true');
      const stolenCoins = Math.max(0, asFiniteNumber(parsedObject?.stolen_coins) ?? 0);
      const latestPrompt = body.prompt?.trim() || normalizeMessages(body.messages).at(-1)?.content || '';

      const attackLog = {
        source: 'direct-backend',
        backend_status: response.status,
        backend_url: targetUrl,
        latest_prompt: latestPrompt,
        assistant_message: typeof parsedObject?.assistant === 'string' ? parsedObject.assistant : null,
        backend_message: typeof parsedObject?.message === 'string' ? parsedObject.message : null,
        backend_log: parsedObject?.log ?? (typeof parsedBody === 'string' ? parsedBody : null),
        called_tools: Array.isArray(parsedObject?.tool_calls) ? parsedObject.tool_calls : [],
        outcome: attackSucceeded ? 'success' : 'failed',
        stolen_coins: stolenCoins,
        base_coins: asFiniteNumber(parsedObject?.base_coins),
        bonus_coins: asFiniteNumber(parsedObject?.bonus_coins),
        elegance_factor: asFiniteNumber(parsedObject?.elegance_factor),
        max_bonus: asFiniteNumber(parsedObject?.max_bonus),
        turn_count: asFiniteNumber(parsedObject?.turn_count),
        char_count: asFiniteNumber(parsedObject?.char_count),
        defender_coins_after: asFiniteNumber(parsedObject?.defender_coins_after),
        attacker_coins_after: asFiniteNumber(parsedObject?.attacker_coins_after),
        defender_eliminated: parsedObject?.defender_eliminated === true
      };

      const { error: attackInsertError } = await supabaseAdmin.from('attacks').insert({
        defended_challenge_id: isPveTarget ? null : (targetDetails?.id ?? defendedChallengeId),
        challenge_id: effectiveChallengeId,
        attacker_user_id: attackerUserId,
        attacker_team_id: attackerTeamId,
        is_successful: attackSucceeded,
        log: attackLog
      });

      if (attackInsertError) {
        console.error('Failed to persist direct-backend attack event', attackInsertError);
      }
    }

    return json(parsedBody ?? { success: response.ok }, { status: response.status });
  } catch (error: any) {
    return json(
      {
        success: false,
        error: error?.message || 'Unexpected error while connecting to attack backend.'
      },
      { status: 500 }
    );
  }
};