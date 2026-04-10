import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
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
};

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

function asValidDateMs(value: string | null | undefined): number | null {
  if (!value) return null;

  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return null;

  return ms;
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
  const payload: Record<string, unknown> = {
    prompt: body.prompt?.trim() || normalizeMessages(body.messages).at(-1)?.content || '',
    guess: body.guess?.trim() || '',
    messages: normalizeMessages(body.messages),
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

    const body = (await request.json()) as AttackRequestBody;
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

    const outboundPayload = buildAttackRequestPayload(body, targetDetails, effectiveChallengeId, targetSecretKey);
    const hasDirectBackend = typeof targetDetails?.challenges?.challenge_url === 'string' && targetDetails.challenges.challenge_url.trim().length > 0;

    if (hasDirectBackend && attackerTeamId) {
      const cooldownTargetColumn = isPveTarget ? 'challenge_id' : 'defended_challenge_id';
      const cooldownTargetValue = isPveTarget ? effectiveChallengeId : (targetDetails?.id ?? defendedChallengeId);

      const { data: mostRecentAttack, error: mostRecentAttackError } = await supabaseAdmin
        .from('attacks')
        .select('created_at')
        .eq('attacker_team_id', attackerTeamId)
        .eq(cooldownTargetColumn, cooldownTargetValue)
        .eq('is_successful', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (mostRecentAttackError) {
        return json({ success: false, error: 'Unable to verify attack cooldown' }, { status: 500 });
      }

      if (mostRecentAttack?.created_at) {
        const lastAttackMs = new Date(mostRecentAttack.created_at).getTime();

        if (!Number.isNaN(lastAttackMs)) {
          const elapsedMs = Date.now() - lastAttackMs;

          if (elapsedMs < ATTACK_COOLDOWN_MS) {
            const remainingSeconds = Math.ceil((ATTACK_COOLDOWN_MS - elapsedMs) / 1000);

            return json({
              success: false,
              message: `Cooldown active for this target. Try again in ${remainingSeconds} seconds.`,
              cooldown_remaining_seconds: remainingSeconds,
              log: 'Attack blocked by cooldown policy.'
            });
          }
        }
      }
    }

    const outboundHeaders: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (!hasDirectBackend) {
      outboundHeaders.Authorization = `Bearer ${accessToken}`;

      if (supabaseAnonKey) {
        outboundHeaders.apikey = supabaseAnonKey;
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

    if (hasDirectBackend && response.ok && parsedBody && typeof parsedBody === 'object' && (parsedBody as any).success === true) {
      const backendReportedTransfer =
        typeof (parsedBody as any).stolen_coins === 'number' ||
        typeof (parsedBody as any).attacker_coins_after === 'number' ||
        typeof (parsedBody as any).defender_coins_after === 'number';

      if (isPveTarget) {
        const rewardCoins = Math.max(0, Math.trunc(targetDetails?.challenges?.attack_steal_coins ?? 0));

        if (rewardCoins > 0 && attackerTeamId) {
          const attackerCoinsAfter = await incrementTeamCoins(supabaseAdmin, attackerTeamId, rewardCoins);

          (parsedBody as any).stolen_coins = rewardCoins;
          (parsedBody as any).attacker_coins_after = attackerCoinsAfter;
        } else {
          (parsedBody as any).stolen_coins = 0;
        }
      } else if (!backendReportedTransfer && attackerTeamId && targetDetails?.team_id && effectiveChallengeId) {
        const transferResult = await applyCoinSteal(supabaseAdmin, attackerTeamId, targetDetails.team_id, effectiveChallengeId);

        if (transferResult.defender_eliminated) {
          await supabaseAdmin
            .from('defended_challenges')
            .update({ is_active: false })
            .eq('team_id', targetDetails.team_id);
        }

        (parsedBody as any).stolen_coins = transferResult.stolen_coins ?? 0;
        (parsedBody as any).defender_coins_after = transferResult.defender_coins ?? null;
        (parsedBody as any).attacker_coins_after = transferResult.attacker_coins ?? null;
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